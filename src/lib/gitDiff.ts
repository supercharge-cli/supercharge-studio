/** Parse `git diff` output into files and hunks, and build single-hunk patches for revert. */
export type GLine = { t: " " | "+" | "-" | "\\"; s: string; a?: number; b?: number };
export type GHunk = { header: string; lines: GLine[] };
export type GFile = { header: string[]; oldPath: string; newPath: string; hunks: GHunk[]; binary: boolean };

export function parseUnifiedDiff(text: string): GFile[] {
  const out: GFile[] = [];
  let f: GFile | null = null;
  let h: GHunk | null = null;
  let a = 0, b = 0;
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const l of lines) {
    if (l.startsWith("diff --git ")) {
      f = { header: [l], oldPath: "", newPath: "", hunks: [], binary: false };
      h = null;
      out.push(f);
      continue;
    }
    if (!f) continue;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) {
      h = { header: l, lines: [] };
      f.hunks.push(h);
      a = +m[1]; b = +m[2];
      continue;
    }
    if (!h) {
      f.header.push(l);
      if (l.startsWith("--- ")) f.oldPath = strip(l.slice(4));
      else if (l.startsWith("+++ ")) f.newPath = strip(l.slice(4));
      else if (l.startsWith("Binary files")) f.binary = true;
      continue;
    }
    const t = l[0] as GLine["t"];
    if (t === "+") h.lines.push({ t, s: l.slice(1), b: b++ });
    else if (t === "-") h.lines.push({ t, s: l.slice(1), a: a++ });
    else if (t === "\\") h.lines.push({ t, s: l.slice(1) });
    else h.lines.push({ t: " ", s: l.slice(1), a: a++, b: b++ });
  }
  return out;
}

const strip = (p: string) => (p === "/dev/null" ? p : p.replace(/^[ab]\//, "").replace(/\t.*$/, ""));

/** A patch with the file header and just hunk `i`; `git apply -R --recount` reverts it. */
export function hunkPatch(f: GFile, i: number): string {
  const h = f.hunks[i];
  const body = h.lines.map((l) => (l.t === "\\" ? "\\" : l.t) + l.s);
  return [...f.header, h.header, ...body].join("\n") + "\n";
}

export const fileStats = (f: GFile) => {
  let add = 0, del = 0;
  for (const h of f.hunks) for (const l of h.lines) { if (l.t === "+") add++; else if (l.t === "-") del++; }
  return { add, del };
};

/** Side-by-side rows: pair runs of removed/added lines. */
export type SideRow = { l?: GLine; r?: GLine };
export function sideBySide(h: GHunk): SideRow[] {
  const rows: SideRow[] = [];
  let dels: GLine[] = [], adds: GLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ l: dels[i], r: adds[i] });
    dels = []; adds = [];
  };
  for (const l of h.lines) {
    if (l.t === "-") dels.push(l);
    else if (l.t === "+") adds.push(l);
    else if (l.t === " ") { flush(); rows.push({ l, r: l }); }
  }
  flush();
  return rows;
}

/** Commit message from the diff when no agent is connected. */
export function heuristicMessage(files: { path: string; y: string; x: string }[], diffs: GFile[] = []): string {
  if (!files.length) return "";
  const added = files.filter((f) => f.y === "?" || f.x === "A").map((f) => f.path);
  const deleted = files.filter((f) => f.y === "D" || f.x === "D").map((f) => f.path);
  const changed = files.filter((f) => !added.includes(f.path) && !deleted.includes(f.path)).map((f) => f.path);
  const base = (p: string) => p.split("/").pop()!;
  const verb = changed.length ? "Update" : added.length ? "Add" : "Remove";
  const names = [...changed, ...added, ...deleted].map(base);
  const subject = `${verb} ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
  const lines: string[] = [];
  const st = new Map(diffs.map((d) => [d.newPath === "/dev/null" ? d.oldPath : d.newPath, fileStats(d)]));
  for (const [list, word] of [[changed, "Update"], [added, "Add"], [deleted, "Remove"]] as const)
    for (const p of list) { const s = st.get(p); lines.push(`- ${word} ${p}${s ? ` (+${s.add} -${s.del})` : ""}`); }
  return files.length === 1 ? subject : `${subject}\n\n${lines.join("\n")}`;
}

/** Tiny keyword highlighter: returns [text, className?] pieces. */
const KW = /\b(const|let|var|function|return|if|else|for|while|import|from|export|class|new|async|await|fn|pub|use|impl|struct|enum|match|type|interface|def|self|true|false|null|None|mut)\b/;
const TOKENS = new RegExp(`("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`[^\`]*\`|//.*$|#.*$|${KW.source}|\\b\\d+(?:\\.\\d+)?\\b)`, "g");
export function highlight(s: string): [string, string?][] {
  const out: [string, string?][] = [];
  let last = 0;
  for (const m of s.matchAll(TOKENS)) {
    if (m.index! > last) out.push([s.slice(last, m.index)]);
    const tok = m[0];
    out.push([tok, /^["'`]/.test(tok) ? "hl-s" : /^(\/\/|#)/.test(tok) ? "hl-c" : /^\d/.test(tok) ? "hl-n" : "hl-k"]);
    last = m.index! + tok.length;
  }
  if (last < s.length) out.push([s.slice(last)]);
  return out;
}

export { editedPaths } from "./git";
