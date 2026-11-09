import { useEffect, useRef, useState } from "react";
import type { ConfigOption, SessionModes } from "../acp/types";
import { Icon } from "./Icon";

export type AgentDraft = { name: string; description: string; instructions: string; scope: "user" | "project" };

export function ModeControl({ modes, currentMode, permission, onMode, onPermission, onCreateAgent, onRefreshAgents }: {
  modes?: SessionModes;
  currentMode?: string;
  permission?: ConfigOption;
  onMode: (id: string) => Promise<void>;
  onPermission: (id: string, value: string) => Promise<void>;
  /** Saves a custom agent through the CLI (ACP) and selects it. */
  onCreateAgent?: (draft: AgentDraft) => Promise<void>;
  /** Reloads agents written by the CLI or by this form. */
  onRefreshAgents?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<AgentDraft>({ name: "", description: "", instructions: "", scope: "user" });
  const [formError, setFormError] = useState("");
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => { if (!anchor.current?.contains(event.target as Node)) { setOpen(false); setCreating(false); } };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  if (!modes?.availableModes?.length && !permission?.options?.length) return null;
  const modeId = currentMode ?? modes?.currentModeId;
  const displayMode = (id: string, name: string) => id === "default" ? "Agent" : id === "ask" ? "Ask (work mode)" : name;
  const modeLabel = displayMode(modeId ?? "default", modes?.availableModes?.find((m) => m.id === modeId)?.name ?? (modeId === "plan" ? "Plan" : "Agent"));
  const permissionLabel = permission?.options?.find((o) => o.value === permission.currentValue)?.name ?? permission?.currentValue;
  const openMenu = () => {
    const next = !open;
    setOpen(next);
    if (next) void onRefreshAgents?.().catch(() => {});
  };
  const choose = async (action: () => Promise<void>) => {
    setPending(true);
    try { await action(); setOpen(false); } catch { /* Keep the menu open; the caller reports the error. */ } finally { setPending(false); }
  };
  return <div className="mode-anchor" ref={anchor} onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); e.stopPropagation(); } }}>
    <button className="mode-trigger" data-mode={modeId ?? "default"} data-testid="mode-trigger" type="button" aria-label={`Chat mode: ${modeLabel}${permissionLabel ? `, permissions: ${permissionLabel}` : ""}`} aria-expanded={open} aria-haspopup="dialog" onClick={openMenu}>
      {modeLabel}{permissionLabel && <> · {permissionLabel}</>} <Icon name="chevronDown" size={12} />
    </button>
    {open && <div className="mode-menu" data-testid="mode-menu" role="dialog" aria-label="Chat mode">
      {!!modes?.availableModes?.length && <section><strong>Work mode</strong><p>Choose how this chat approaches the task.</p>
        {modes.availableModes.map((mode) => <button key={mode.id} type="button" data-testid={`mode-${mode.id}`} aria-pressed={mode.id === modeId} disabled={pending} onClick={() => void choose(() => onMode(mode.id))}>
          <span><b>{displayMode(mode.id, mode.name)}</b>{mode.description && <small>{mode.description}</small>}</span>{mode.id === modeId && <Icon name="check" size={14} />}
        </button>)}
        {onCreateAgent && (creating ? <form className="mode-create" data-testid="mode-create" onSubmit={(e) => {
          e.preventDefault();
          void choose(async () => {
            setFormError("");
            try { await onCreateAgent(draft); setCreating(false); setDraft({ name: "", description: "", instructions: "", scope: "user" }); }
            catch (err) { setFormError(err instanceof Error ? err.message : String(err)); throw err; }
          });
        }}>
          <label>Name<input data-testid="mode-create-name" value={draft.name} placeholder="reviewer" onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <label>Description<input value={draft.description} placeholder="What this agent is for" onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
          <label>Instructions<textarea data-testid="mode-create-instructions" value={draft.instructions} placeholder="How this chat should work" rows={4} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} /></label>
          <label>Save in<select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value === "project" ? "project" : "user" })}><option value="user">Your account (~/.supercharge)</option><option value="project">This project</option></select></label>
          {formError && <small className="mode-create-error">{formError}</small>}
          <span className="mode-create-actions"><button type="button" disabled={pending} onClick={() => setCreating(false)}>Cancel</button><button type="submit" data-testid="mode-create-save" disabled={pending}>Save agent</button></span>
        </form> : <button type="button" data-testid="mode-create-open" onClick={() => { setCreating(true); setFormError(""); }}>Create your own</button>)}
      </section>}
      {!!permission?.options?.length && <section><strong>Tool permissions</strong><p>Applies only to this chat. Always approve skips tool prompts.</p>
        {permission.options.map((choice) => <button key={choice.value} type="button" data-testid={`mode-permission-${choice.value}`} aria-pressed={choice.value === permission.currentValue} disabled={pending} onClick={() => void choose(() => onPermission(permission.id, choice.value))}>
          <span><b>{choice.name ?? choice.value}</b></span>{choice.value === permission.currentValue && <Icon name="check" size={14} />}
        </button>)}
      </section>}
    </div>}
  </div>;
}
