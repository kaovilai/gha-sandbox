// Scenario selection from prompt text + text-generation (title/commit/PR) detection.
// T3 wraps the user's text as:
//   <t3_code_instructions>...</t3_code_instructions>\n\n<user_request>\n<text>\n</user_request>
// so selection looks only at the text after the LAST <user_request> (or whole prompt if absent).

export function promptText(prompt) {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((b) => (b && typeof b === "object" && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function userRequest(text) {
  const i = text.lastIndexOf("<user_request>");
  let rest = i < 0 ? text : text.slice(i + "<user_request>".length);
  const j = rest.indexOf("</user_request>");
  if (j >= 0) rest = rest.slice(0, j);
  // Follow-up turns (observed in CI): T3 appends "<runtime_info>...</runtime_info>" to the user text.
  const k = rest.indexOf("<runtime_info>");
  if (k >= 0) rest = rest.slice(0, k);
  return rest.trim();
}

const TAG = /\[mock:([a-z0-9_-]+)([^\]]*)\]/gi;

// -> { id, args:{k:v}, text } | null ; `text` = user text with the tag removed.
export function parseTag(text) {
  let m;
  let last = null;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(text))) last = m;
  if (!last) return null;
  const args = {};
  for (const kv of last[2].trim().split(/\s+/).filter(Boolean)) {
    const eq = kv.indexOf("=");
    if (eq > 0) args[kv.slice(0, eq)] = kv.slice(eq + 1);
    else args[kv] = "1";
  }
  return { id: last[1].toLowerCase(), args, text: stripTags(text) };
}

export function stripTags(text) {
  return text.replace(TAG, "").replace(/[ \t]+/g, " ").trim();
}

// Text-generation sessions (thread titles, commit messages, PR text, branch names) use the same
// provider binary. They must never run a scenario.
export function isTextGen({ clientName, text }) {
  if (clientName === "t3-code-git-text") return true;
  if (/<user_request>/.test(text)) return false;
  return /Return (a )?(valid )?JSON/i.test(text);
}
