import { useState } from "react";
import type { PlanApprovalResult } from "../acp/types";

export function PlanApprovalModal({ plan, onAnswer }: { plan: string; onAnswer: (r: PlanApprovalResult) => void }) {
  const [feedback, setFeedback] = useState("");
  const [revising, setRevising] = useState(false);
  return (
    <div className="modal-bg">
      <div className="modal" role="alertdialog" aria-modal="true" aria-label="Approve plan" data-testid="plan-approval">
        <h3>Approve this plan?</h3>
        <p className="muted">The agent wrote the plan and is waiting to leave plan mode.</p>
        {plan.trim() ? <pre className="mono plan-approval-body">{plan}</pre> : <p>The plan file is empty.</p>}
        {revising && (
          <label>What should change?
            <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} data-testid="plan-feedback" />
          </label>
        )}
        <div className="perm-options">
          <button data-testid="plan-approve" onClick={() => onAnswer({ outcome: "approved" })}>Approve</button>
          {revising ? (
            <button className="secondary" data-testid="plan-revise" onClick={() => onAnswer({ outcome: "cancelled", feedback: feedback.trim() })}>Send changes</button>
          ) : (
            <button className="secondary" data-testid="plan-revise" onClick={() => setRevising(true)}>Request changes</button>
          )}
          <button className="ghost" data-testid="plan-abandon" onClick={() => onAnswer({ outcome: "abandoned" })}>Abandon</button>
        </div>
      </div>
    </div>
  );
}
