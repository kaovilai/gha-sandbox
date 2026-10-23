// Scenario registry: every sibling *.mjs (except this file) default-exports {id,title,steps(ctx)}.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let cache;
export async function loadScenarios() {
  if (cache) return cache;
  const map = new Map();
  for (const f of readdirSync(here).filter((f) => f.endsWith(".mjs") && f !== "index.mjs").sort()) {
    const mod = await import(pathToFileURL(join(here, f)).href);
    if (mod.default?.id) map.set(mod.default.id, mod.default);
  }
  return (cache = map);
}
