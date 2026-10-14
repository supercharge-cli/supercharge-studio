import { useEffect, useRef, useState } from "react";
import type { ConfigOption, SessionModes } from "../acp/types";
import { Icon } from "./Icon";

export function ModeControl({ modes, currentMode, permission, onMode, onPermission }: {
  modes?: SessionModes;
  currentMode?: string;
  permission?: ConfigOption;
  onMode: (id: string) => Promise<void>;
  onPermission: (id: string, value: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  if (!modes?.availableModes?.length && !permission?.options?.length) return null;
  const modeId = currentMode ?? modes?.currentModeId;
  const displayMode = (id: string, name: string) => id === "default" ? "Agent" : id === "ask" ? "Ask (work mode)" : name;
  const modeLabel = displayMode(modeId ?? "default", modes?.availableModes?.find((m) => m.id === modeId)?.name ?? (modeId === "plan" ? "Plan" : "Agent"));
  const permissionLabel = permission?.options?.find((o) => o.value === permission.currentValue)?.name ?? permission?.currentValue;
  const choose = async (action: () => Promise<void>) => {
    setPending(true);
    try { await action(); setOpen(false); } catch { /* Keep the menu open; the caller reports the error. */ } finally { setPending(false); }
  };
  return <div className="mode-anchor" ref={anchor} onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); e.stopPropagation(); } }}>
    <button className="mode-trigger" data-testid="mode-trigger" type="button" aria-label={`Chat mode: ${modeLabel}${permissionLabel ? `, permissions: ${permissionLabel}` : ""}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((x) => !x)}>
      {modeLabel}{permissionLabel && <> · {permissionLabel}</>} <Icon name="chevronDown" size={12} />
    </button>
    {open && <div className="mode-menu" data-testid="mode-menu" role="dialog" aria-label="Chat mode">
      {!!modes?.availableModes?.length && <section><strong>Work mode</strong><p>Choose how this chat approaches the task.</p>
        {modes.availableModes.map((mode) => <button key={mode.id} type="button" data-testid={`mode-${mode.id}`} aria-pressed={mode.id === modeId} disabled={pending} onClick={() => void choose(() => onMode(mode.id))}>
          <span><b>{displayMode(mode.id, mode.name)}</b>{mode.description && <small>{mode.description}</small>}</span>{mode.id === modeId && <Icon name="check" size={14} />}
        </button>)}
      </section>}
      {!!permission?.options?.length && <section><strong>Tool permissions</strong><p>Applies only to this chat. Always approve skips tool prompts.</p>
        {permission.options.map((choice) => <button key={choice.value} type="button" data-testid={`mode-permission-${choice.value}`} aria-pressed={choice.value === permission.currentValue} disabled={pending} onClick={() => void choose(() => onPermission(permission.id, choice.value))}>
          <span><b>{choice.name ?? choice.value}</b></span>{choice.value === permission.currentValue && <Icon name="check" size={14} />}
        </button>)}
      </section>}
    </div>}
  </div>;
}
