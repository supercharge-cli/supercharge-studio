/**
 * Release notes (the GitHub Release body, published from WHATS_NEW.md) as short plain lines for
 * the update prompt. Headings, HTML comments and blank lines are dropped; list markers, links and
 * emphasis are flattened. Capped so a huge body can't flood the prompt.
 */
export const releaseNotes = (md?: string): string[] =>
  String(md ?? "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*(#|<!--|$)/.test(l))
    .map((l) => l.replace(/^\s*([-*+]|\d+\.)\s+/, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "").trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((l) => (l.length > 180 ? `${l.slice(0, 179)}…` : l));

/** "What's new" list for an update prompt; nothing when the release has no notes. */
export function Notes({ md, open }: { md?: string; open?: boolean }) {
  const n = releaseNotes(md);
  return n.length ? <details className="update-notes" open={open}><summary>What's new</summary><ul>{n.map((x) => <li key={x}>{x}</li>)}</ul></details> : null;
}
