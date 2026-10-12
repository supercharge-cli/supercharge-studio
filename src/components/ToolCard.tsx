import type { ToolCall } from "../acp/types";
import { blockText } from "../acp/session";
import { Icon } from "./Icon";

export function ToolCard({ tc, compact }: { tc: ToolCall; compact?: boolean }) {
  return (
    <details className={`toolcard ${tc.status}`} open={!compact && tc.status === "in_progress"}>
      <summary>
        <span className="dot" />
        <Icon name={tc.kind === "fetch" ? "globe" : "tool"} size={14} />
        <span className="tc-title">{tc.title}</span>
        <span className={`tc-status ${tc.status}`}>{tc.status.replace("_", " ")}</span>
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
