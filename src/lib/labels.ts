/**
 * Agent-provided labels (permission options, titles) sometimes name the assistant
 * persona. Studio always presents the agent as "the agent", so we neutralise that
 * name generically: learn it from phrases like "tell <Name> what to do" and swap
 * every standalone occurrence. No names are hard-coded here.
 */
const LEARN = [/\btell ([A-Z][\w-]*) what\b/, /\blet ([A-Z][\w-]*) (?:decide|continue|proceed)\b/, /\b([A-Z][\w-]*) will (?:run|edit|execute)\b/];
const KEEP = new Set(["Supercharge", "Yes", "No", "Allow", "Reject", "Always", "Bash", "Shell", "I", "It", "This", "The"]);

export function personaNames(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const re of LEARN) { const m = re.exec(t); if (m && !KEEP.has(m[1])) out.add(m[1]); }
  return [...out];
}

export function neutralize(text: string, names: string[]): string {
  let s = text;
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(`\\btell ${esc}\\b`, "g"), "tell the agent").replace(new RegExp(`(^|[.!?]\\s+)${esc}\\b`, "g"), "$1The agent").replace(new RegExp(`\\b${esc}\\b`, "g"), "the agent");
  }
  return s;
}

/** Returns the request with option names (and the tool title) neutralised. */
export function cleanPermission<T extends { options: { name: string }[]; toolCall: { title?: string | null } }>(req: T): T {
  const names = personaNames([...req.options.map((o) => o.name), req.toolCall.title ?? ""]);
  if (!names.length) return req;
  return { ...req, options: req.options.map((o) => ({ ...o, name: neutralize(o.name, names) })), toolCall: { ...req.toolCall, title: req.toolCall.title ? neutralize(req.toolCall.title, names) : req.toolCall.title } };
}
