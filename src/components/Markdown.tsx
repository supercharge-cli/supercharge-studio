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
      blocks.push(<pre key={k++} className="md-code" data-lang={fence[1] || undefined}><code>{body.join("\n")}</code></pre>);
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
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|> )/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={k++}>{para.flatMap((p, j) => (j ? [<br key={`b${j}`} />, ...inline(p, j * 100)] : inline(p)))}</p>);
  }
  return <div className="md">{blocks}</div>;
});
