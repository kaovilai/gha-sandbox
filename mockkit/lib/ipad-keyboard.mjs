// Emulates an iPadOS on-screen keyboard inside a Chromium page, for the web bug where the composer and the
// terminal end up behind the keyboard while typing.
//
// iPadOS ignores the `interactive-widget=resizes-content` viewport hint (apps/web/index.html): the keyboard
// shrinks only `window.visualViewport`, the layout viewport keeps its height, and WebKit pans the smaller
// visual viewport to keep the focused field in view. Android and desktop Chromium honor the hint, so their
// layout viewport shrinks with the keyboard and the app fits. That difference is why the bug "does not
// reproduce" anywhere except an iPad.
//
// `installIpadKeyboard(context)` replaces `window.visualViewport` with a stub that fires the same
// `resize`/`scroll` events WebKit fires, and `openKeyboard` / `closeKeyboard` drive it. While it is open a
// strip is painted over the rows the keyboard physically covers, so screenshots and recordings show what an
// iPad user sees. The stub never pans the visual viewport (`offsetTop` stays 0): Safari's pan is a
// browser-level transform the page cannot observe, and leaving it out keeps the evidence to what the page
// itself reports.
export const IPAD_KEYBOARD_HEIGHT = 320;

const STRIP_ID = "__ipad_keyboard_strip";

// One function body, installable either before navigation (context) or into the loaded page.
const INSTALL_IPAD_KEYBOARD = ({ stripId }) => {
    const state = { open: false, height: 320, hidden: false };
    const listeners = { resize: new Set(), scroll: new Set() };
    const fire = (type) => {
      for (const fn of listeners[type]) {
        try {
          fn(new Event(type));
        } catch {}
      }
    };
    const viewport = {
      get width() {
        return window.innerWidth;
      },
      get height() {
        return Math.max(0, window.innerHeight - (state.open ? state.height : 0));
      },
      get offsetTop() {
        return 0;
      },
      get offsetLeft() {
        return 0;
      },
      get pageTop() {
        return window.scrollY;
      },
      get pageLeft() {
        return window.scrollX;
      },
      get scale() {
        return 1;
      },
      addEventListener(type, fn) {
        if (listeners[type]) listeners[type].add(fn);
      },
      removeEventListener(type, fn) {
        if (listeners[type]) listeners[type].delete(fn);
      },
      dispatchEvent() {
        return true;
      },
      onresize: null,
      onscroll: null,
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => viewport });

    const paint = () => {
      const existing = document.getElementById(stripId);
      if (!state.open) {
        existing?.remove();
        return;
      }
      const el = existing ?? document.documentElement.appendChild(document.createElement("div"));
      el.id = stripId;
      el.setAttribute("data-ipad-keyboard", "true");
      Object.assign(el.style, {
        position: "fixed",
        left: "0",
        right: "0",
        bottom: "0",
        height: `${state.height}px`,
        zIndex: "2147483647",
        pointerEvents: "none",
        display: state.hidden ? "none" : "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 24px",
        background: "linear-gradient(#3f3f46, #27272a)",
        color: "#fafafa",
        font: "600 19px/1.35 ui-sans-serif, system-ui, -apple-system, sans-serif",
        textAlign: "center",
        whiteSpace: "pre-line",
        borderTop: "2px solid #a1a1aa",
      });
      el.textContent = [
        `iPad on-screen keyboard (simulated): covers the bottom ${state.height} px of the screen`,
        `layout viewport is still ${window.innerHeight} px tall (iPadOS ignores interactive-widget=resizes-content)`,
      ].join("\n");
    };
    // The strip is a sibling of #root; repaint only if something removes it from <html>.
    new MutationObserver(paint).observe(document.documentElement, { childList: true });

    window.__ipadKeyboard = {
      open(height = state.height) {
        state.open = true;
        state.height = height;
        paint();
        fire("resize");
        return window.__ipadKeyboard.state();
      },
      close() {
        state.open = false;
        paint();
        fire("resize");
        return window.__ipadKeyboard.state();
      },
      // Hide the strip but keep the keyboard state, so a shot can show the rows it covers (see cutaway()).
      cutaway(on) {
        state.hidden = on;
        paint();
      },
      state() {
        return {
          open: state.open,
          height: viewport.height,
          offsetTop: viewport.offsetTop,
          layoutHeight: window.innerHeight,
        };
      },
    };
};

export async function installIpadKeyboard(context) {
  await context.addInitScript(INSTALL_IPAD_KEYBOARD, { stripId: STRIP_ID });
}

// The mock runner owns the browser context, so drivers install into the already-loaded page instead.
export async function installIpadKeyboardNow(page) {
  await page.evaluate(INSTALL_IPAD_KEYBOARD, { stripId: STRIP_ID });
}

export async function openKeyboard(page, height = IPAD_KEYBOARD_HEIGHT) {
  return page.evaluate((h) => window.__ipadKeyboard.open(h), height);
}

export async function closeKeyboard(page) {
  return page.evaluate(() => window.__ipadKeyboard.close());
}

// Hide the opaque strip and mark the keyboard's top edge instead, so a screenshot can show the rows the
// keyboard covers in the same state. The dashed line is where the keyboard starts.
export async function cutaway(page, on = true) {
  await page.evaluate((enable) => {
    window.__ipadKeyboard.cutaway(enable);
    const lineId = "__ipad_keyboard_edge";
    let line = document.getElementById(lineId);
    if (!enable) {
      line?.remove();
      return;
    }
    const vv = window.visualViewport;
    const top = Math.round((vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight));
    line ??= document.documentElement.appendChild(document.createElement("div"));
    line.id = lineId;
    Object.assign(line.style, {
      position: "fixed",
      left: "0",
      right: "0",
      top: `${top}px`,
      height: "0",
      borderTop: "3px dashed #dc2626",
      zIndex: "2147483646",
      pointerEvents: "none",
    });
  }, on);
}

// How far Safari has to pan the visual viewport to keep the caret in view, in px. Each keystroke that moves the
// caret to a new line changes this: the pan is what the user sees as the page jumping while typing.
export async function caretPan(page) {
  return page.evaluate(() => {
    const vv = window.visualViewport;
    const sel = document.getSelection();
    const range = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    if (range) range.collapse(false);
    const caret = range ? range.getBoundingClientRect() : null;
    const visibleTop = Math.round(vv?.offsetTop ?? 0);
    const visibleBottom = visibleTop + Math.round(vv?.height ?? window.innerHeight);
    const bottom = caret ? Math.round(caret.bottom) : null;
    return { caretBottom: bottom, visibleTop, visibleBottom, requiredPan: bottom === null ? null : Math.max(0, bottom - visibleBottom) };
  });
}

export async function keyboardState(page) {
  return page.evaluate(() => window.__ipadKeyboard.state());
}

// What is on screen versus what the page lays out: every box is measured in layout-viewport coordinates, so
// `coveredBy` is how much of that box the keyboard hides.
export async function measureScreen(page) {
  return page.evaluate(() => {
    const vv = window.visualViewport;
    const r = (n) => Math.round(n);
    const box = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: r(b.top), bottom: r(b.bottom), height: r(b.height) };
    };
    const q = (sel) => document.querySelector(sel);
    const visibleTop = r(vv?.offsetTop ?? 0);
    const visibleBottom = visibleTop + r(vv?.height ?? window.innerHeight);
    const send =
      document.querySelector('[aria-label="Send message"]') ??
      [...document.querySelectorAll("button")].find((b) =>
        /send|submit/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""} ${b.getAttribute("data-testid") ?? ""}`),
      );
    const shell = q('[data-slot="sidebar-wrapper"]');
    const composer = q('[data-chat-composer-main-surface="true"]');
    const terminal = q('[data-terminal-owner="drawer"]');
    const menu = q('[data-composer-drawer-layer="true"]');
    const overflow = (el) => (el ? getComputedStyle(el).overflow : null);
    const covered = (b) => (b ? Math.max(0, b.bottom - visibleBottom) : null);
    const boxes = {
      shell: box(shell),
      composer: box(composer),
      sendButton: box(send),
      terminalDrawer: box(terminal),
      commandMenu: box(menu),
    };
    return {
      layoutHeight: window.innerHeight,
      visualViewport: vv ? { height: r(vv.height), offsetTop: visibleTop, visibleBottom } : null,
      // #19513 (open) writes these on <html> when its visual-viewport sync engages; its gate is portrait phones.
      viewportSync: document.documentElement.dataset.viewportSync ?? null,
      keyboardOpenFlag: document.documentElement.dataset.keyboardOpen ?? null,
      documentScrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      pageOverflow: { html: overflow(document.documentElement), body: overflow(document.body) },
      boxes,
      // Every labelled control inside the composer, so a renamed send button is diagnosable from the log.
      composerControls: [...document.querySelectorAll('[data-chat-composer-form="true"] button')].map((b) => ({
        label: (b.getAttribute("aria-label") ?? b.getAttribute("title") ?? b.textContent ?? "").trim().slice(0, 40),
        bottom: box(b)?.bottom ?? null,
      })),
      coveredByKeyboard: {
        shellTop: boxes.shell ? Math.max(0, visibleTop - boxes.shell.top) : null,
        composer: covered(boxes.composer),
        sendButton: covered(boxes.sendButton),
        terminalDrawer: covered(boxes.terminalDrawer),
        commandMenu: covered(boxes.commandMenu),
      },
    };
  });
}

export function summarize(screen) {
  const { boxes, coveredByKeyboard: c, visualViewport: vv } = screen;
  const fmt = (b) => (b ? `${b.top}..${b.bottom}px` : "absent");
  return [
    `layout=${screen.layoutHeight}px visible=${vv ? `${vv.offsetTop}..${vv.visibleBottom}px (h=${vv.height})` : "none"}`,
    `composer=${fmt(boxes.composer)} send=${fmt(boxes.sendButton)} covered=${c.composer}px/send ${c.sendButton}px`,
    `terminal=${fmt(boxes.terminalDrawer)} covered=${c.terminalDrawer}px`,
    `menu=${fmt(boxes.commandMenu)} covered=${c.commandMenu}px`,
    `page-scrollable=${screen.documentScrollable} overflow:html=${screen.pageOverflow.html} body=${screen.pageOverflow.body}`,
    `viewport-sync=${screen.viewportSync ?? "off"}`,
  ].join(" | ");
}
