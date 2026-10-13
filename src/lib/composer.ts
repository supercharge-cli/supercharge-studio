import { score } from "../components/CommandPalette";

/** One row in the composer's pop-up menu (slash commands, sub-options or @ mentions). */
export type MenuItem = { id: string; label: string; detail?: string; group?: string; icon?: string; value: string };

/** What the menu should show for the text before the caret. */
export type MenuState =
  | { kind: "slash"; q: string }
  | { kind: "sub"; cmd: string; q: string }
  | { kind: "mention"; q: string; start: number; end: number }
  | null;

/**
 * `/xyz` (whole draft, no space yet) → command list; `/cmd partial` → that command's
 * options (only for commands that have them); `@path` anywhere after whitespace → file picker.
 */
export function menuState(draft: string, caret: number, hasSub: (cmd: string) => boolean = () => false): MenuState {
  const before = draft.slice(0, caret);
  const m = before.match(/(^|\s)@([^\s@]*)$/);
  if (m) return { kind: "mention", q: m[2], start: caret - m[2].length - 1, end: caret };
  const s = draft.match(/^\/([^\s/]*)$/);
  if (s && caret === draft.length) return { kind: "slash", q: s[1] };
  const sub = draft.match(/^\/([\w-]+) (\S*)$/);
  if (sub && caret === draft.length && hasSub(sub[1])) return { kind: "sub", cmd: sub[1], q: sub[2] };
  return null;
}

/** Fuzzy-filter and rank items; prefix matches on the label win, then fuzzy score; stable otherwise. */
export function filterItems(items: MenuItem[], q: string, max = 60): MenuItem[] {
  if (!q) return items.slice(0, max);
  const ql = q.toLowerCase();
  return items
    .map((it, i) => {
      const l = it.label.toLowerCase();
      const s = l.startsWith(ql) ? 1000 - l.length : Math.max(score(q, it.label) * 4, score(q, `${it.label} ${it.detail ?? ""}`));
      return { it, s, i };
    })
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, max)
    .map((x) => x.it);
}

/** Parse "/name rest" from a draft. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = text.trim().match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
  return m ? { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() } : null;
}

/** Replace the @token at [start,end) with `@path ` and return the new draft and caret. */
export function insertMention(draft: string, start: number, end: number, path: string): { draft: string; caret: number } {
  const ins = `@${/\s/.test(path) ? `"${path}"` : path} `;
  const next = draft.slice(0, start) + ins + draft.slice(end).replace(/^\s+/, "");
  return { draft: next, caret: start + ins.length };
}
