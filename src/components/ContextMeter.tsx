import { lazy, Suspense, useEffect, useState } from "react";
import type { ConfigOption } from "../acp/types";
const ContextWindowPop = lazy(() => import("./ContextWindowPop").then((m) => ({ default: m.ContextWindowPop })));

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export type WindowCtl = { option?: ConfigOption; ext: boolean; current?: number | "auto" | null; onSet: (v: number | "auto") => Promise<void> | void };

/** Ring showing how much of the model's context window the session uses; click it to change the window. */
export function ContextMeter({ used, max, window: win }: { used: number; max?: number; window?: WindowCtl }) {
  const [open, setOpen] = useState(false);
  const p = max ? Math.min(1, used / max) : 0;
  const tip = max ? `Context: ${used.toLocaleString()} / ${max.toLocaleString()} tokens (${Math.round(p * 100)}%)` : `Context: ${used.toLocaleString()} tokens used`;
  const c = 2 * Math.PI * 7;
  const can = !!win && (!!win.option || win.ext);
  useEffect(() => { if (!open) return; const f = (e: MouseEvent) => { if (!(e.target as Element).closest?.(".ctx-anchor")) setOpen(false); }; addEventListener("mousedown", f); return () => removeEventListener("mousedown", f); }, [open]);
  const ring = (
    <>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" className="ctx-bg" />{max ? <circle cx="9" cy="9" r="7" className="ctx-fg" strokeDasharray={`${p * c} ${c}`} transform="rotate(-90 9 9)" /> : null}</svg>
      <span>{max ? `${Math.round(p * 100)}%` : fmt(used)}</span>
    </>
  );
  const cls = `ctx-meter ${p > 0.9 ? "hot" : p > 0.7 ? "warm" : ""}`;
  if (!can) return <span className={cls} data-testid="context-meter" title={tip} aria-label={tip} role="img">{ring}</span>;
  return (
    <span className="ctx-anchor" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <button type="button" className={`${cls} ctx-btn`} data-testid="context-meter" title={`${tip}. Click to change the context window`} aria-label={tip} aria-expanded={open} onClick={() => setOpen(!open)}>{ring}</button>
      {open && <Suspense fallback={null}><ContextWindowPop used={used} max={max} ctl={win!} onDone={() => setOpen(false)} /></Suspense>}
    </span>
  );
}
export { fmt as fmtTokens };
