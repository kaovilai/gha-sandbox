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

export async function installIpadKeyboard(context) {
  await context.addInitScript(({ stripId }) => {
    const state = { open: false, height: 320 };
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
        display: "flex",
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
      state() {
        return {
          open: state.open,
          height: viewport.height,
          offsetTop: viewport.offsetTop,
          layoutHeight: window.innerHeight,
        };
      },
    };
  }, { stripId: STRIP_ID });
}

export async function openKeyboard(page, height = IPAD_KEYBOARD_HEIGHT) {
  return page.evaluate((h) => window.__ipadKeyboard.open(h), height);
}

export async function closeKeyboard(page) {
  return page.evaluate(() => window.__ipadKeyboard.close());
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
      [...document.querySelectorAll("button")].find((b) => /^send/i.test(b.getAttribute("aria-label") ?? ""));
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
      documentScrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      pageOverflow: { html: overflow(document.documentElement), body: overflow(document.body) },
      boxes,
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
  ].join(" | ");
}
