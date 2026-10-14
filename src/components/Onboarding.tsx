import { useState } from "react";
import { Icon } from "./Icon";

type Step = { id: string; title: string; body: string; done: boolean; action?: { label: string; run: () => void } };

/** First-run checklist: connect the agent, add a provider, open a project. */
export function Onboarding(props: {
  connected: boolean;
  connecting: boolean;
  status: string;
  hasProvider: boolean;
  hasProject: boolean;
  onConnect: () => void;
  onConnection: () => void;
  onProviders: () => void;
  onDismiss: () => void;
  /** Desktop only: offer "start at login and keep running", checked by default. */
  onBackground?: (enabled: boolean) => void;
}) {
  const [bg, setBg] = useState(true);
  const dismiss = () => { props.onBackground?.(bg); props.onDismiss(); };
  const steps: Step[] = [
    {
      id: "agent",
      title: "Connect the agent",
      body: props.connected ? "Connected to supercharge agent serve." : props.connecting ? "Connecting…" : props.status || "Studio talks to a local supercharge agent over ACP.",
      done: props.connected,
      action: props.connected ? undefined : { label: props.connecting ? "Connecting…" : "Retry", run: props.onConnect },
    },
    { id: "provider", title: "Add a model provider", body: "Bring your own endpoint and key; keys stay in the OS keychain.", done: props.hasProvider, action: { label: props.hasProvider ? "Manage" : "Add provider", run: props.onProviders } },
    { id: "project", title: "Open a project", body: "Add a folder in the sidebar, then start a chat.", done: props.hasProject },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <section className="onboard" data-testid="onboarding" aria-labelledby="onboard-title">
      <div className="onboard-head">
        <div className="empty-icon"><Icon name="bolt" size={26} /></div>
        <div>
          <h2 id="onboard-title">Welcome to Supercharge Studio</h2>
          <p className="muted">{doneCount} of {steps.length} ready</p>
        </div>
      </div>
      <div className="onboard-bar" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount}><i style={{ transform: `scaleX(${doneCount / steps.length})` }} /></div>
      <ol className="onboard-steps">
        {steps.map((s, i) => (
          <li key={s.id} className={s.done ? "done" : ""} data-testid={`onboard-${s.id}`}>
            <span className="onboard-num" aria-hidden>{s.done ? <Icon name="check" size={13} /> : i + 1}</span>
            <div className="onboard-text"><b>{s.title}</b><span>{s.body}</span></div>
            {s.action && <button className="secondary compact" disabled={s.id === "agent" && props.connecting} onClick={s.action.run}>{s.action.label}</button>}
          </li>
        ))}
      </ol>
      {props.onBackground && (
        <label className="check onboard-bg"><input type="checkbox" data-testid="onboard-background" checked={bg} onChange={(e) => setBg(e.target.checked)} /> Start at login and keep running in the background, so my phone can always reach this computer</label>
      )}
      <div className="row end">
        {!props.connected && <button className="ghost compact" onClick={props.onConnection}>Connection settings</button>}
        <button className="ghost compact" data-testid="onboard-dismiss" onClick={dismiss}>{doneCount === steps.length ? "Done" : "Skip for now"}</button>
      </div>
    </section>
  );
}
