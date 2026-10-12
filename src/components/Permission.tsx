import type { PermissionOutcome, PermissionRequest } from "../acp/types";

export function PermissionModal({ req, onAnswer }: { req: PermissionRequest; onAnswer: (o: PermissionOutcome) => void }) {
  return (
    <div className="modal-bg">
      <div className="modal">
        <h3>Allow tool?</h3>
        <p>{req.toolCall.title ?? req.toolCall.toolCallId}</p>
        {req.toolCall.rawInput != null && <pre className="mono">{JSON.stringify(req.toolCall.rawInput, null, 2)}</pre>}
        <div className="row end">
          <button className="secondary" onClick={() => onAnswer({ outcome: "cancelled" })}>Cancel</button>
          {req.options.map((o) => (
            <button key={o.optionId} className={o.kind.startsWith("reject") ? "secondary" : ""} onClick={() => onAnswer({ outcome: "selected", optionId: o.optionId })}>
              {o.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
