import { useState } from "react";
import { parseWindow, WINDOW_CHOICES, windowLabel } from "../lib/contextWindow";
import type { WindowCtl } from "./ContextMeter";
import "./contextWindow.css";

/** Popover: used / max and the context-window select (Auto, presets, Custom…). */
export default function ContextWindowPop({ used, max, ctl, onDone }: { used: number; max?: number; ctl: WindowCtl; onDone: () => void }) {
  const cur = ctl.option?.currentValue ?? (ctl.current == null ? "auto" : String(ctl.current));
  const preset = WINDOW_CHOICES.some((c) => c.value === String(cur));
  const [custom, setCustom] = useState(!preset);
  const [text, setText] = useState(preset ? "" : String(cur));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const extra = (ctl.option?.options ?? []).filter((o) => !WINDOW_CHOICES.some((c) => c.value === o.value));
  const apply = async (v: number | "auto") => {
    setBusy(true); setErr("");
    try { await ctl.onSet(v); onDone(); } catch (e: any) { setErr(String(e?.message ?? e)); } finally { setBusy(false); }
  };
  const pct = max ? Math.round(Math.min(1, used / max) * 100) : null;
  return (
    <div className="ctx-pop" data-testid="ctx-pop" role="dialog" aria-label="Context window">
      <div className="ctx-pop-used"><b>{used.toLocaleString()}</b> / {max ? max.toLocaleString() : "?"} tokens{pct != null && <span className="muted"> · {pct}%</span>}</div>
      <div className="ctx-pop-bar"><span style={{ width: `${pct ?? 0}%` }} /></div>
      <label className="ctx-pop-label">Context window
        <select data-testid="ctx-window-select" disabled={busy} value={custom ? "custom" : String(cur)} onChange={(e) => {
          const v = e.target.value;
          if (v === "custom") { setCustom(true); return; }
          setCustom(false);
          void apply(v === "auto" ? "auto" : Number(v));
        }}>
          {WINDOW_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          {extra.map((o) => <option key={o.value} value={o.value}>{windowLabel(o.value)}</option>)}
          <option value="custom">Custom…</option>
        </select>
      </label>
      {custom && <form className="ctx-pop-custom" onSubmit={(e) => { e.preventDefault(); const v = parseWindow(text); if (v == null) setErr("Enter a size like 300k, 1.5m or 350000."); else void apply(v); }}>
        <input autoFocus data-testid="ctx-window-custom" placeholder="e.g. 300k or 1.5m" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="primary sm" disabled={busy}>Set</button>
      </form>}
      {err && <p className="ctx-pop-err" role="alert">{err}</p>}
      <p className="muted small">Auto uses the size the model reports.</p>
    </div>
  );
}
export { ContextWindowPop };
