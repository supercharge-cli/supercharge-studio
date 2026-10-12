import type { ToolCall } from "../acp/types";
import { blockText } from "../acp/session";

export function ToolCard({ tc, compact }: { tc: ToolCall; compact?: boolean }) {
  return (
    <details className={`toolcard ${tc.status}`} open={!compact && tc.status === "in_progress"}>
      <summary>
        <span className="dot" /> {tc.title} <span className="muted">{tc.kind ?? ""} · {tc.status}</span>
      </summary>
      {tc.locations.map((l, i) => (
        <div key={i} className="muted mono">{l.path}{l.line ? `:${l.line}` : ""}</div>
      ))}
      {tc.content.map((c: any, i) =>
        c.type === "diff" ? (
          <pre key={i} className="mono">--- {c.path}{"\n"}{c.newText}</pre>
        ) : c.type === "content" ? (
          c.content?.type === "image" ? (
            <img key={i} src={`data:${c.content.mimeType};base64,${c.content.data}`} alt="" />
          ) : (
            <pre key={i} className="mono">{blockText(c.content)}</pre>
          )
        ) : c.type === "terminal" ? (
          <div key={i} className="muted">terminal {c.terminalId}</div>
        ) : null,
      )}
    </details>
  );
}
