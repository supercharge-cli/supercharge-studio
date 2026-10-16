import { useEffect, useRef, useState } from "react";
import type { ConfigOption } from "../acp/types";
import { effortLabel, sameEffort } from "../lib/sessionOptions";
import { Icon } from "./Icon";

/** Thinking-level chip with a popover slider. Levels come from the agent's reasoning_effort option. */
export function ThinkingControl({ option, modelName, onSelect, onModel }: { option?: ConfigOption; modelName?: string; onSelect: (value: string) => void; onModel: () => void }) {
  const [open, setOpen] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const levels = option?.options ?? [];
  const [drag, setDrag] = useState<number | null>(null);
  const cur = Math.max(0, levels.findIndex((l) => sameEffort(l.value, option?.currentValue)));
  const [want, setWant] = useState<number | null>(null);
  useEffect(() => setWant(null), [option?.currentValue]);
  const idx = drag ?? want ?? cur;
  const def = option && (option as any).defaultValue != null ? Math.max(0, levels.findIndex((l) => sameEffort(l.value, (option as any).defaultValue))) : 0;
  useEffect(() => { if (!open) return; const f = (e: MouseEvent) => { if (!(e.target as Element).closest?.(".thinking-anchor")) setOpen(false); }; addEventListener("mousedown", f); return () => removeEventListener("mousedown", f); }, [open]);
  if (!option || levels.length < 2) return <button className="secondary thinking-chip" data-testid="thinking-chip" disabled title="This agent doesn't offer thinking levels for the current model">Thinking <span aria-hidden="true">⌄</span></button>;
  const name = (i: number) => effortLabel(levels[i]?.value ?? "", levels[i]?.name);
  const pick = (i: number) => { const j = Math.min(levels.length - 1, Math.max(0, i)); const v = levels[j]; if (v && !sameEffort(v.value, option.currentValue)) { setWant(j); onSelect(v.value); } };
  const at = (x: number) => { const r = track.current!.getBoundingClientRect(); return Math.round(((x - r.left) / r.width) * (levels.length - 1)); };
  const clampI = (i: number) => Math.min(levels.length - 1, Math.max(0, i));
  const pct = (idx / (levels.length - 1)) * 100;
  return (
    <div className="thinking-anchor" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <button className="secondary thinking-chip" data-testid="thinking-chip" aria-expanded={open} title="Thinking effort" onClick={() => setOpen(!open)}>{name(want ?? cur) || "Select effort"} <span aria-hidden="true">⌄</span></button>
      {open && <div className="thinking-pop" data-testid="thinking-pop" role="dialog" aria-label="Thinking effort">
        <button className="icon sm thinking-reset" aria-label="Reset to default" title="Reset to default" onClick={() => pick(def)}><Icon name="refresh" size={13} /></button>
        <div className="thinking-title">{name(idx)}</div>
        <button className="thinking-model" onClick={() => { setOpen(false); onModel(); }}>{modelName ?? "Model"} ›</button>
        <div className="thinking-track" ref={track} role="slider" tabIndex={0} aria-valuemin={0} aria-valuemax={levels.length - 1} aria-valuenow={idx} aria-valuetext={name(idx)} data-testid="thinking-slider"
          onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); pick(idx + 1); } if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); pick(idx - 1); } }}
          onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setDrag(clampI(at(e.clientX))); }}
          onPointerMove={(e) => { if (drag != null) setDrag(clampI(at(e.clientX))); }}
          onPointerUp={(e) => { if (drag != null) pick(clampI(at(e.clientX))); setDrag(null); }}>
          <div className="thinking-fill" style={{ width: `calc(${pct}% + 14px)` }} />
          {levels.map((l, i) => <span key={l.value} className="thinking-dot" style={{ left: `calc(14px + (100% - 28px) * ${i / (levels.length - 1)})` }} />)}
          <span className="thinking-thumb" style={{ left: `calc(14px + (100% - 28px) * ${idx / (levels.length - 1)})` }} />
        </div>
      </div>}
    </div>
  );
}
