// Native (X11) helpers for desktop scenarios: xdotool input, real-desktop screenshots. Zero deps.
import { execFileSync, spawnSync } from "node:child_process";

const display = () => process.env.DISPLAY || ":99";
const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, DISPLAY: display() } });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findWindow(name = "^T3 Code") {
  const out = run("xdotool", ["search", "--onlyvisible", "--name", name]).stdout.trim().split("\n").filter(Boolean);
  return out[0] ?? null;
}

export function xdo(...args) {
  const r = run("xdotool", args.map(String));
  if (r.status !== 0) console.log(`xdotool ${args.join(" ")} -> status ${r.status} ${r.stderr.trim()}`);
  return r.stdout.trim();
}

// Place the app window at 0,0 WxH and focus it (no window manager runs under Xvfb, so this is plain X).
export function placeWindow(win, w, h) {
  xdo("windowsize", win, w, h);
  xdo("windowmove", win, 0, 0);
  xdo("windowfocus", win);
}

// Real X11 root capture: shows window chrome (titlebar overlay), native menus, GTK dialogs, i.e. what a user sees.
export function rootShot(path) {
  execFileSync("import", ["-window", "root", path], { env: { ...process.env, DISPLAY: display() } });
}

export function windowTree() {
  return run("xwininfo", ["-root", "-tree"]).stdout;
}

export function native(win) {
  return {
    win,
    xdo,
    sleep,
    rootShot,
    windowTree,
    focus: () => xdo("windowfocus", win),
    // xdotool key syntax: "ctrl+comma", "alt", "Escape", "ctrl+k" ...
    key: async (keys, { settle = 700 } = {}) => {
      xdo("windowfocus", win);
      xdo("key", "--clearmodifiers", keys);
      await sleep(settle);
    },
    click: async (x, y, { settle = 600 } = {}) => {
      xdo("mousemove", x, y, "click", 1);
      await sleep(settle);
    },
    move: (x, y) => xdo("mousemove", x, y),
  };
}
