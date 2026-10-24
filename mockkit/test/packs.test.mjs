// node --test mockkit/test : packs.json stays consistent with the driver files (a typo would only show up as a CI FAIL otherwise).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { labelOf, resolveScenarios } from "../lib/resolve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packs = JSON.parse(readFileSync(join(here, "../packs.json"), "utf8"));
const driverFile = (id) => ["scenarios-ui", "scenarios-desktop"].map((d) => join(here, "..", d, `${id}.mjs`)).find((f) => existsSync(f));

test("every scenario named in a pack has a driver file", () => {
  for (const [name, list] of Object.entries(packs)) {
    if (list === "*") continue;
    for (const id of list) assert.ok(driverFile(id), `pack ${name}: no driver for ${id}`);
  }
});

test("desktop-wide pack: web drivers that run inside the Electron window (no dk* native drivers needed)", () => {
  const ids = packs["desktop-wide"];
  for (const id of ["s05", "s07", "s09", "s10", "s13", "s14", "s15", "s17"]) assert.ok(ids.some((i) => i.startsWith(`${id}-`)), `desktop-wide misses ${id}`);
  const found = new Map(ids.map((i) => [i, driverFile(i)]));
  const out = resolveScenarios("desktop-wide", { packs, found, drivers: [...found.keys()] });
  assert.equal(out.length, ids.length);
  assert.ok(out.every((e) => e.prov === "grok"));
  const codex = resolveScenarios("desktop-wide-codex", { packs, found, drivers: [...found.keys()] });
  assert.deepEqual(codex.map(labelOf), ids.map((i) => `codex-${i}`));
});
