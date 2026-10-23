// Central masking of runner identity in recordings: hostname (`runnervm...`) and absolute runner / workspace paths.
//
// DOM text replacement, not a screenshot filter: an init script rewrites text nodes (and keeps rewriting through a
// MutationObserver), so BOTH screenshots and the recorded video show the masked text, and the replacement also
// applies after reloads / navigations. `maskNow(page)` runs a synchronous sweep right before every screenshot.
// Drivers keep asserting on their own (unmasked) text: nothing they match on contains a runner path or hostname.
//
//   const rules = buildMaskRules({ ws, root });
//   await installMaskContext(context, rules);      // web: Playwright context (before the first navigation)
//   await installMaskPage(page, rules);            // desktop (CDP-attached page): current document + future ones
//   await maskNow(page, rules);                    // before each shot; returns leftover leaks (input values, etc.)
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
  for (const [src, flags, to] of extra) rules.push([src, flags, to]);
  // generic safety nets (other dirs under the runner home / workspace checkout)
  rules.push(["/home/runner(?:/work)?(?:/_temp)?", "g", MASK_HOME]);
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

// Runs IN THE PAGE (serialised by Playwright). Idempotent.
export function maskInit(rules) {
  if (globalThis.__mockkitMask) return;
  const res = rules.map(([src, flags, to]) => [new RegExp(src, flags), to]);
  const fix = (s) => {
    let o = s;
    for (const [re, to] of res) o = o.replace(re, to);
    return o;
  };
  const fixNode = (n) => {
    const v = n.nodeValue;
    if (!v) return;
    const f = fix(v);
    if (f !== v) n.nodeValue = f;
  };
  const sweep = (root) => {
    if (!root) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const tag = n.parentElement?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") continue;
      fixNode(n);
    }
  };
  // <input>/<textarea> values are not text nodes (env var rows in Settings > Providers show absolute paths): rewrite them too, but
  // never the focused one (a driver may be typing a real workspace path into it) and never password fields.
  const fixInputs = () => {
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "")) return; // someone (a driver) is typing: hands off every field
    for (const e of document.querySelectorAll("input,textarea")) {
      if (e === document.activeElement || e.type === "password") continue;
      const v = e.value;
      if (!v) continue;
      const f = fix(v);
      if (f !== v) e.value = f;
    }
  };
  globalThis.__mockkitMask = {
    sweep: () => {
      sweep(document.body);
      fixInputs();
    },
  };
  const start = () => {
    sweep(document.body);
    setInterval(fixInputs, 400);
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "characterData") fixNode(m.target);
        else for (const added of m.addedNodes) added.nodeType === 3 ? fixNode(added) : added.nodeType === 1 ? sweep(added) : 0;
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
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

// Synchronous sweep (text nodes + input values) before a screenshot; returns what is still visible after it (e.g. the focused input).
export async function maskNow(page, rules) {
  // only rules whose replacement does not itself match (e.g. "/tmp" -> "/tmp") can be checked for leftovers
  const checkable = rules.filter(([src, flags, to]) => !new RegExp(src, flags).test(to));
  return page
    .evaluate(
      ([rs]) => {
        globalThis.__mockkitMask?.sweep();
        const seen = [document.body.innerText, ...[...document.querySelectorAll("input,textarea")].map((e) => e.value ?? "")].join("\n");
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
