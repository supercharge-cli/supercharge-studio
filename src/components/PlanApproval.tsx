import { useState } from "react";
import type { PlanApprovalResult } from "../acp/types";
import { Markdown } from "./Markdown";

/** Review stays in the plan tab so the chat remains usable while approval is pending. */
export function PlanApproval({ plan, onAnswer }: { plan: string; onAnswer: (r: PlanApprovalResult) => void }) {
  const [feedback, setFeedback] = useState("");
  const [revising, setRevising] = useState(false);
  return <section className="plan-review" aria-label="Plan review" data-testid="plan-approval">
    <div className="plan-review-scroll">
      <div className="plan-review-intro"><span className="plan-review-status"><span aria-hidden="true" /> Awaiting your review</span><h2>Review the plan</h2><p>Read the proposal, then approve it or ask for changes.</p></div>
      {plan.trim() ? <article className="plan-document" aria-label="Proposed plan"><Markdown text={plan} /></article> : <p className="plan-review-empty">The agent did not provide plan content.</p>}
    </div>
    <div className="plan-review-actions">
      {revising && <label className="plan-feedback">What should change?<textarea autoFocus value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} placeholder="Describe the changes you want…" data-testid="plan-feedback" /></label>}
      <div className="plan-review-buttons">
        {revising ? <><button data-testid="plan-revise" disabled={!feedback.trim()} onClick={() => onAnswer({ outcome: "cancelled", feedback: feedback.trim() })}>Send changes</button><button className="secondary" onClick={() => setRevising(false)}>Back</button></> : <><button data-testid="plan-approve" onClick={() => onAnswer({ outcome: "approved" })}>Approve plan</button><button className="secondary" data-testid="plan-revise" onClick={() => setRevising(true)}>Request changes</button></>}
        <button className="ghost plan-abandon" data-testid="plan-abandon" onClick={() => onAnswer({ outcome: "abandoned" })}>Abandon</button>
      </div>
    </div>
  </section>;
}
