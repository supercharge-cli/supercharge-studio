import { memo, ReactNode } from "react";

/** Minimal, safe Markdown: fences, headings, lists, quotes, inline code/bold/italic/links. No HTML. */
function inline(s: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0, m: RegExpExecArray | null, k = key;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    else if (m[4]) out.push(<a key={k++} href={m[5]} target="_blank" rel="noreferrer">{t.slice(1, t.indexOf("]"))}</a>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  return (
    <div className="md-codewrap">
      <div className="md-codehead"><span>{lang || "code"}</span><button className="md-copy" aria-label="Copy code" onClick={(e) => { void navigator.clipboard?.writeText(code); const b = e.currentTarget; b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200); }}>Copy</button></div>
      <pre className="md-code" data-lang={lang || undefined}><code>{code}</code></pre>
    </div>
  );
}

/** Split a GFM table row into cells; `\|` and pipes inside backticks stay in the cell. */
export function cells(row: string): string[] {
  const r = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out: string[] = [];
  let cur = "", tick = false;
  for (let i = 0; i < r.length; i++) {
    const c = r[i];
    if (c === "\\" && r[i + 1] === "|") { cur += "|"; i++; }
    else if (c === "`") { tick = !tick; cur += c; }
    else if (c === "|" && !tick) { out.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}
const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isTable = (ls: string[], i: number) => i + 1 < ls.length && ls[i].includes("|") && SEP.test(ls[i + 1]) && ls[i + 1].includes("-") && cells(ls[i]).length === cells(ls[i + 1]).length;
type Align = "left" | "right" | "center" | undefined;

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0, k = 0;
  while (i < lines.length) {
    const l = lines[i];
    const fence = l.match(/^```(\w*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(<CodeBlock key={k++} lang={fence[1]} code={body.join("\n")} />);
      continue;
    }
    if (isTable(lines, i)) {
      const head = cells(l);
      const al: Align[] = cells(lines[i + 1]).map((c) => (c.startsWith(":") ? (c.endsWith(":") ? "center" : "left") : c.endsWith(":") ? "right" : undefined));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={k++} className="md-tablewrap" role="region" aria-label="Table" tabIndex={0}>
          <table className="md-table">
            <thead><tr>{head.map((c, j) => <th key={j} style={al[j] && { textAlign: al[j] }}>{inline(c)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, j) => <td key={j} style={al[j] && { textAlign: al[j] }}>{inline(r[j] ?? "")}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) { blocks.push(<div key={k++} className={`md-h md-h${h[1].length}`}>{inline(h[2])}</div>); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(<li key={items.length}>{inline(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>);
      blocks.push(ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>);
      continue;
    }
    if (l.startsWith("> ")) { blocks.push(<blockquote key={k++}>{inline(l.slice(2))}</blockquote>); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isTable(lines, i) && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|> )/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={k++}>{para.flatMap((p, j) => (j ? [<br key={`b${j}`} />, ...inline(p, j * 100)] : inline(p)))}</p>);
  }
  return <div className="md">{blocks}</div>;
});
