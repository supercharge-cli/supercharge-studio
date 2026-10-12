import { memo, useMemo, useState } from "react";
import type { ToolCall } from "../acp/types";
import { blockText } from "../acp/session";
import { diffLines, diffStats, hunks } from "../lib/diff";
import { Icon } from "./Icon";

function Diff({ path, oldText, newText }: { path: string; oldText?: string | null; newText: string }) {
  const lines = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  const st = diffStats(lines);
  const hs = useMemo(() => hunks(lines), [lines]);
  return (
    <div className="diff" data-testid="diff">
      <div className="diff-head"><Icon name="file" size={13} /><span className="mono">{path}</span><span className="add">+{st.add}</span><span className="del">−{st.del}</span></div>
      <div className="diff-body mono">
        {hs.map((h, i) => (
          <div key={i} className="hunk">
            {i > 0 && <div className="diff-gap">⋯</div>}
            {h.lines.map((l, j) => (
              <div key={j} className={`dl ${l.t === "+" ? "add" : l.t === "-" ? "del" : ""}`}>
                <span className="ln">{l.a ?? ""}</span><span className="ln">{l.b ?? ""}</span><span className="sg">{l.t}</span><span className="tx">{l.s}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function summaryOf(tc: ToolCall) {
  const d = tc.content.filter((c: any) => c.type === "diff") as any[];
  if (d.length) {
    const st = d.map((x) => diffStats(diffLines(x.oldText, x.newText))).reduce((a, b) => ({ add: a.add + b.add, del: a.del + b.del }), { add: 0, del: 0 });
    return <span className="tc-diffstat"><span className="add">+{st.add}</span> <span className="del">−{st.del}</span></span>;
  }
  return null;
}

export const ToolCard = memo(function ToolCard({ tc, compact }: { tc: ToolCall; compact?: boolean }) {
  const hasDiff = tc.content.some((c: any) => c.type === "diff");
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? (!compact && (tc.status === "in_progress" || hasDiff));
  const cmd = (tc.rawInput as any)?.command;
  return (
    <div className={`toolcard ${tc.status} ${isOpen ? "open" : ""}`} data-testid="toolcard">
      <button className="tc-summary" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
        <span className="dot" />
        <Icon name={hasDiff ? "file" : tc.kind === "fetch" ? "globe" : "tool"} size={14} />
        <span className="tc-title">{tc.title}</span>
        {summaryOf(tc)}
        <span className={`tc-status ${tc.status}`}>{tc.status.replace("_", " ")}</span>
        <span className="chev"><Icon name="chevronDown" size={14} /></span>
      </button>
      <div className="tc-collapse"><div className="tc-inner">
        {typeof cmd === "string" && <pre className="mono tc-cmd">$ {cmd}</pre>}
        {tc.locations.map((l, i) => (
          <div key={i} className="muted mono">{l.path}{l.line ? `:${l.line}` : ""}</div>
        ))}
        {isOpen && tc.content.map((c: any, i) =>
          c.type === "diff" ? (
            <Diff key={i} path={c.path} oldText={c.oldText} newText={c.newText} />
          ) : c.type === "content" ? (
            c.content?.type === "image" ? (
              <img key={i} src={`data:${c.content.mimeType};base64,${c.content.data}`} alt="Tool output image" />
            ) : (
              <pre key={i} className="mono">{blockText(c.content)}</pre>
            )
          ) : c.type === "terminal" ? (
            <div key={i} className="muted">terminal {c.terminalId}</div>
          ) : null,
        )}
      </div></div>
    </div>
  );
});
