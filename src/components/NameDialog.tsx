import { createElement, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { pushOverlay } from "../browser/visibility";
import type { AskNameOpts } from "../lib/askName";

/** Small modal with one text field. Enter = OK, Esc = cancel. Hides the native side browser while open. */
export function NameDialog({ title, label, initial = "", placeholder, ok = "Create", validate, onDone }: AskNameOpts & { onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  const [touched, setTouched] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => pushOverlay(), []);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const err = validate?.(v) ?? (v.trim() ? null : "Enter a name");
  const submit = () => { setTouched(true); if (!err) onDone(v.trim()); };
  return (
    <div className="modal-bg" data-testid="name-dialog" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(null); }}>
      <div className="modal name-dialog" role="dialog" aria-modal="true" aria-label={title}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onDone(null); } }}>
        <h3>{title}</h3>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          {label && <label className="small muted" htmlFor="name-dialog-input">{label}</label>}
          <input id="name-dialog-input" ref={input} data-testid="name-input" value={v} placeholder={placeholder} aria-invalid={!!(touched || v) && !!err}
            onChange={(e) => { setV(e.target.value); setTouched(true); }} />
          <div className="name-err small" style={{ color: "var(--bad)", minHeight: 18, marginTop: 4 }} data-testid="name-error" role="alert">{(touched || v !== initial) && err ? err : "\u00a0"}</div>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="ghost" onClick={() => onDone(null)}>Cancel</button>
            <button type="submit" className="primary" data-testid="name-ok" disabled={!!err}>{ok}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Render the dialog in its own root; `done` gets the name or null. */
export function mountNameDialog(o: AskNameOpts, done: (v: string | null) => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(NameDialog, { ...o, onDone: (v: string | null) => { root.unmount(); host.remove(); done(v); } }));
}
