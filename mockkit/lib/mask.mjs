// Central masking of runner identity in recordings: hostname (`runnervm...`) and absolute runner / workspace paths.
//
// DOM text replacement, not a screenshot filter: an init script rewrites text nodes (and keeps rewriting through a
// MutationObserver), so BOTH screenshots and the recorded video show the masked text, and the replacement also
// applies after reloads / navigations. `maskNow(page)` runs a synchronous sweep right before every screenshot.
// Drivers keep asserting on their own (unmasked) text: nothing they match on contains a runner path or hostname.
//
// Surfaces covered (each one was a leak in round 1):
//   * light DOM text nodes                         MutationObserver + sweep
//   * shadow DOM (diff panel, file tree, code)     `attachShadow` is wrapped so EVERY new shadow root (open or closed) gets its own
//                                                  observer; roots that predate the init script (desktop: attached after load) are
//                                                  found by walking `el.shadowRoot`; a slow safety-net interval re-walks everything
//   * canvas text (the Ghostty terminal)           `CanvasRenderingContext2D.fillText` is wrapped: the string is rewritten before it is
//                                                  drawn, padded with trailing spaces to its old length so the monospace grid and the
//                                                  cursor stay aligned
//   * <input>/<textarea> values                    not focused: the value is rewritten. FOCUSED (a driver is typing the real path):
//                                                  the value is never touched (the real value must reach the app); a transparent-text
//                                                  overlay showing the masked value is drawn over the field instead, so screenshots and
//                                                  video show the masked text and blur/focus changes are harmless
//
//   const rules = buildMaskRules({ ws, root });
//   await installMaskContext(context, rules);      // web: Playwright context (before the first navigation)
//   await installMaskPage(page, rules);            // desktop (CDP-attached page): current document + future ones
//   await maskNow(page, rules);                    // before each shot; returns leftover leaks (light DOM + shadow DOM + inputs)
//   await maskStats(page);                         // { canvasMasked, canvasDraws, roots, overlays }: proof the hooks engaged
import { hostname as osHostname, homedir } from "node:os";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

export const MASK_HOST = "sandbox-vm";
export const MASK_HOME = "/home/dev";

// Rule = [regexSource, flags, replacement]. Longest literal paths first so a workspace path never half-matches its parent.
export function buildMaskRules({ ws, root, tmp = process.env.RUNNER_TEMP || "/tmp", hostname = osHostname(), home = homedir(), extra = [] } = {}) {
  const rules = [];
  const lit = (p, to) => {
    if (typeof p === "string" && p.length > 3 && p.startsWith("/")) rules.push([esc(trimSlash(p)), "g", to]);
  };
  const wsPath = ws ? trimSlash(ws) : null;
  const wsParent = wsPath ? wsPath.replace(/\/[^/]+$/, "") : null;
  const paths = [];
  if (wsPath) paths.push([wsPath, `${MASK_HOME}/demo-app`]);
  if (wsParent) paths.push([wsParent, `${MASK_HOME}`]);
  if (root) paths.push([root, `${MASK_HOME}/.sandbox`]);
  if (tmp && trimSlash(tmp) !== "/tmp") paths.push([tmp, "/tmp"]);
  if (home) paths.push([home, MASK_HOME]);
  paths.sort((a, b) => b[0].length - a[0].length);
  for (const [p, to] of paths) lit(p, to);
  // `~`-relative spellings of the same paths (shell prompts `\w`, T3 abbreviates the home directory in some labels)
  const homeTrim = home && home.length > 1 ? trimSlash(home) : null;
  if (homeTrim) {
    for (const [p, to] of paths) {
      if (p !== homeTrim && p.startsWith(`${homeTrim}/`) && p.length - homeTrim.length > 3) {
        const tildeTo = to.startsWith(`${MASK_HOME}/`) ? `~${to.slice(MASK_HOME.length)}` : to === MASK_HOME ? "~" : to;
        rules.push([esc(`~${p.slice(homeTrim.length)}`), "g", tildeTo]);
      }
    }
  }
  for (const [src, flags, to] of extra) rules.push([src, flags, to]);
  // generic safety nets (other dirs under the runner home / workspace checkout)
  rules.push(["/home/runner(?:/work)?(?:/_temp)?", "g", MASK_HOME]);
  rules.push(["~/work(?:/_temp)?", "g", "~"]);
  rules.push(["/Users/runner", "g", MASK_HOME]);
  if (hostname && hostname.length >= 4 && !/^localhost/i.test(hostname)) rules.push([esc(hostname.split(".")[0]), "gi", MASK_HOST]);
  rules.push(["runnervm[a-z0-9]+", "gi", MASK_HOST]);
  return rules;
}

// Pure string version (unit tests; same semantics as the in-page script).
export function applyMask(text, rules) {
  let out = text;
  for (const [src, flags, to] of rules) out = out.replace(new RegExp(src, flags), to);
  return out;
}

// Canvas variant: the masked string is padded back to its original length (terminal cells stay aligned).
export function applyMaskPadded(text, rules) {
  const out = applyMask(text, rules);
  return out.length < text.length ? out + " ".repeat(text.length - out.length) : out;
}

// Runs IN THE PAGE (serialised by Playwright). Idempotent.
export function maskInit(rules) {
  if (globalThis.__mockkitMask) return;
  const res = rules.map(([src, flags, to]) => [new RegExp(src, flags), to]);
  const fix = (s) => {
    let o = s;
    for (const [re, to] of res) o = o.replace(re, to);
    return o;
  };
  const fixPadded = (s) => {
    const o = fix(s);
    return o.length < s.length ? o + " ".repeat(s.length - o.length) : o;
  };
  const stats = { canvasMasked: 0, canvasDraws: 0 };
  const fixNode = (n) => {
    const v = n.nodeValue;
    if (!v) return;
    const f = fix(v);
    if (f !== v) n.nodeValue = f;
  };

  // ---- shadow roots: every root we know about (open ones found by walking, any new one through attachShadow) -------------------
  const roots = new Set(); // ShadowRoot (strong refs: a leaked root is a few KB, a scenario lives minutes)
  const observeRoot = (root) => {
    if (!root || roots.has(root)) return;
    roots.add(root);
    sweepNode(root);
    new MutationObserver(onMutations).observe(root, { subtree: true, childList: true, characterData: true });
  };
  const sweepNode = (node) => {
    if (!node) return;
    if (node.nodeType === 3) return fixNode(node);
    // walk text nodes AND elements (an element may carry an open shadow root with more text inside)
    const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n = node.nodeType === 1 ? node : w.nextNode();
    for (; n; n = w.nextNode()) {
      if (n.nodeType === 3) {
        const tag = n.parentElement?.tagName;
        if (tag !== "SCRIPT" && tag !== "STYLE") fixNode(n);
      } else if (n.shadowRoot) observeRoot(n.shadowRoot);
    }
  };
  function onMutations(muts) {
    for (const m of muts) {
      if (m.type === "characterData") fixNode(m.target);
      else for (const added of m.addedNodes) added.nodeType === 3 ? fixNode(added) : added.nodeType === 1 ? sweepNode(added) : 0;
    }
  }
  const origAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const sr = origAttach.call(this, init);
    try {
      observeRoot(sr); // closed roots too: we hold the reference
    } catch {}
    return sr;
  };

  // ---- canvas text (Ghostty terminal draws style runs with fillText) -------------------------------------------------------------
  for (const Ctx of [globalThis.CanvasRenderingContext2D, globalThis.OffscreenCanvasRenderingContext2D]) {
    const orig = Ctx?.prototype?.fillText;
    if (!orig) continue;
    Ctx.prototype.fillText = function (text, x, y, maxWidth) {
      stats.canvasDraws += 1;
      const t = String(text);
      const m = fixPadded(t);
      if (m !== t) stats.canvasMasked += 1;
      return maxWidth === undefined ? orig.call(this, m, x, y) : orig.call(this, m, x, y, maxWidth);
    };
  }

  // ---- <input>/<textarea> values -------------------------------------------------------------------------------------------------
  const overlays = new Map(); // field -> overlay element (only fields that are focused AND hold something maskable)
  const allFields = () => {
    const out = [...document.querySelectorAll("input,textarea")];
    for (const r of roots) out.push(...r.querySelectorAll("input,textarea"));
    return out;
  };
  const isFocused = (e) => {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return e === a;
  };
  const opaqueBackground = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (c && c !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(c)) return c;
    }
    return "#fff";
  };
  const drawOverlay = (el, masked) => {
    let ov = overlays.get(el);
    if (!ov) {
      ov = document.createElement("div");
      ov.setAttribute("data-mockkit-mask-overlay", "");
      ov.setAttribute("aria-hidden", "true");
      document.documentElement.appendChild(ov);
      overlays.set(el, ov);
    }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const s = ov.style;
    s.cssText = [
      "position:fixed",
      "pointer-events:none",
      "z-index:2147483647",
      "overflow:hidden",
      "box-sizing:border-box",
      `left:${r.left}px`,
      `top:${r.top}px`,
      `width:${r.width}px`,
      `height:${r.height}px`,
      `padding:${cs.padding}`,
      `border:${cs.borderTopWidth} solid transparent`,
      `font:${cs.font}`,
      `letter-spacing:${cs.letterSpacing}`,
      `line-height:${cs.lineHeight}`,
      `text-align:${cs.textAlign}`,
      `color:${cs.color}`,
      `background:${opaqueBackground(el)}`,
      `white-space:${el.tagName === "TEXTAREA" ? "pre-wrap" : "pre"}`,
    ].join(";");
    if (ov.textContent !== masked) ov.textContent = masked;
  };
  const clearOverlay = (el) => {
    const ov = overlays.get(el);
    if (ov) {
      ov.remove();
      overlays.delete(el);
    }
  };
  const fixInputs = () => {
    for (const [el] of overlays) if (!el.isConnected) clearOverlay(el);
    for (const e of allFields()) {
      if (e.type === "password") continue;
      const v = e.value;
      if (!v) {
        clearOverlay(e);
        continue;
      }
      const f = fix(v);
      if (f === v) {
        clearOverlay(e);
        continue;
      }
      if (isFocused(e)) {
        drawOverlay(e, f); // real value untouched (the app reads it), what is DRAWN is masked
      } else {
        clearOverlay(e);
        e.value = f;
      }
    }
  };

  // Text that is really on screen: light DOM + every shadow root + field values (focused/overlaid fields count as their masked text).
  const visibleText = () => {
    const parts = [document.body?.innerText ?? ""];
    for (const r of roots) parts.push(r.textContent ?? "");
    for (const e of allFields()) {
      if (e.type === "password" || !e.value) continue;
      parts.push(overlays.has(e) ? fix(e.value) : e.value);
    }
    return parts.join("\n");
  };

  globalThis.__mockkitMask = {
    sweep: () => {
      sweepNode(document.body);
      fixInputs();
    },
    text: visibleText,
    stats: () => ({ ...stats, roots: roots.size, overlays: overlays.size }),
  };
  const start = () => {
    sweepNode(document.body);
    // roots that existed before this script (desktop: attached to an already loaded renderer) are found by the walk above
    new MutationObserver(onMutations).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    setInterval(fixInputs, 250);
    setInterval(() => sweepNode(document.body), 1500); // safety net (roots/nodes the observers could not see)
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

export async function installMaskContext(context, rules) {
  await context.addInitScript(maskInit, rules);
}

// Attached (CDP) page: init script for later documents, plus the one already loaded.
export async function installMaskPage(page, rules) {
  await page.addInitScript(maskInit, rules);
  await page.evaluate(maskInit, rules);
}

// Synchronous sweep (text nodes in light + shadow DOM, input values) before a screenshot; returns what is still visible after it.
export async function maskNow(page, rules) {
  // only rules whose replacement does not itself match (e.g. "/tmp" -> "/tmp") can be checked for leftovers
  const checkable = rules.filter(([src, flags, to]) => !new RegExp(src, flags).test(to));
  return page
    .evaluate(
      ([rs]) => {
        globalThis.__mockkitMask?.sweep();
        const seen = globalThis.__mockkitMask?.text() ?? document.body.innerText;
        const leaks = [];
        for (const [src] of rs) {
          const m = seen.match(new RegExp(src, "i"));
          if (m) leaks.push(m[0].slice(0, 80));
        }
        return leaks;
      },
      [checkable],
    )
    .then((leaks) => {
      if (leaks.length) console.log(`MASK-LEAK still visible after masking: ${JSON.stringify(leaks)}`);
      return leaks;
    })
    .catch(() => []);
}

// Collects every leak `maskNow` reports (one call per screenshot) so a runner can FAIL the scenario instead of only logging MASK-LEAK.
//   const guard = maskGuard(rules);  run({ beforeShot: guard.beforeShot });  ...  guard.assertClean(id);
export function maskGuard(rules) {
  const seen = [];
  return {
    beforeShot: async (page) => {
      const leaks = await maskNow(page, rules);
      seen.push(...leaks);
      return leaks;
    },
    leaks: () => [...seen],
    assertClean(label = "scenario") {
      if (seen.length) throw new Error(`MASK-LEAK in ${label}: runner identity visible in a screenshot after masking: ${JSON.stringify([...new Set(seen)])}`);
    },
  };
}

// Counters of the in-page hooks (canvas fillText calls rewritten, shadow roots observed, input overlays): lets a driver prove the mask engaged.
export async function maskStats(page) {
  return page.evaluate(() => globalThis.__mockkitMask?.stats() ?? null).catch(() => null);
}
