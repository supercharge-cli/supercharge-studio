const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Ring showing how much of the model's context window the session uses. */
export function ContextMeter({ used, max }: { used: number; max?: number }) {
  const p = max ? Math.min(1, used / max) : 0;
  const tip = max ? `Context: ${used.toLocaleString()} / ${max.toLocaleString()} tokens (${Math.round(p * 100)}%)` : `Context: ${used.toLocaleString()} tokens used`;
  const c = 2 * Math.PI * 7;
  return (
    <span className={`ctx-meter ${p > 0.9 ? "hot" : p > 0.7 ? "warm" : ""}`} data-testid="context-meter" title={tip} aria-label={tip} role="img">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" className="ctx-bg" />{max ? <circle cx="9" cy="9" r="7" className="ctx-fg" strokeDasharray={`${p * c} ${c}`} transform="rotate(-90 9 9)" /> : null}</svg>
      <span>{max ? `${Math.round(p * 100)}%` : fmt(used)}</span>
    </span>
  );
}
export { fmt as fmtTokens };
