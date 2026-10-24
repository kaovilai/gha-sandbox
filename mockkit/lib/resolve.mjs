// Resolve a SCENARIOS spec into [{ id, prov }] entries (shared by the desktop runner; unit-tested).
//   spec     comma list of driver ids, short prefixes ("s03", "dk02") or pack names (packs.json; "*" = every driver)
//   prov     token suffix "@codex"/"@grok" wins; else a pack/token whose name has a "codex" word (codex, codex-smoke, desktop-codex)
//            => codex (same for "claude" words: claude, claude-smoke, desktop-claude => claude); else envProv: grok (default) | codex | claude |
//            both (= grok+codex: every token runs twice) | all (= grok+codex+claude: thrice) | any "+"/"," list (claude+grok)
// Unknown/ambiguous tokens are kept verbatim so the caller reports them as FAIL.
export const labelOf = (e) => (e.prov === "codex" ? `codex-${e.id}` : e.prov === "claude" ? `claude-${e.id}` : e.id); // evidence file prefix

// envProv ("grok" | "codex" | "claude" | "both" | "all" | "claude+grok" ...) -> ordered unique provider list
export const expandProviders = (envProv = "grok") => [
  ...new Set(
    String(envProv)
      .toLowerCase()
      .split(/[+,]/)
      .flatMap((t) => (t === "both" ? ["grok", "codex"] : t === "all" ? ["grok", "codex", "claude"] : t === "codex" || t === "claude" ? [t] : ["grok"])),
  ),
];

export function resolveScenarios(spec, { packs, found, drivers, envProv = "grok" }) {
  const has = (id) => (found instanceof Map ? found.has(id) : found.includes(id));
  const out = new Map();
  for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [tok, atProv] = raw.split("@");
    const provs = atProv ? [atProv] : /(^|-)codex($|-)/.test(tok) ? ["codex"] : /(^|-)claude($|-)/.test(tok) ? ["claude"] : expandProviders(envProv);
    const list = packs[tok] ? (packs[tok] === "*" ? drivers : packs[tok]) : [tok];
    for (const prov of provs)
      for (const t of list) {
        const hit = has(t) ? [t] : drivers.filter((d) => d.startsWith(`${t}-`));
        const e = { id: hit.length === 1 ? hit[0] : t, prov };
        out.set(labelOf(e), e);
      }
  }
  return [...out.values()];
}
