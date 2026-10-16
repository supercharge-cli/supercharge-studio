import { lazy, Suspense, useState, type ReactNode } from "react";
import type { ConfigOption } from "../acp/types";
import { optionFor } from "../lib/sessionOptions";
import { Icon } from "./Icon";
const ThinkingControl = lazy(() => import("./ThinkingControl").then((m) => ({ default: m.ThinkingControl })));
import { ContextMeter } from "./ContextMeter";

export function ModelControls({ options, onSelect, children, context }: { options: ConfigOption[]; onSelect: (id: string, value: string) => void; children?: ReactNode; context?: { used: number; max?: number } }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const model = optionFor(options, "model");
  const reasoning = optionFor(options, "reasoning_effort");
  const active = model?.options?.find((choice) => choice.value === model.currentValue);
  if (!model && !reasoning && !children) return null;
  const choices = (model?.options ?? []).filter((choice) => `${choice.name ?? ""} ${choice.value}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="model-controls" data-testid="composer-chips">
      {model && <div className="model-menu-anchor" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
        <button className="secondary model-trigger" data-testid="model-trigger" aria-haspopup="dialog" aria-label={`Model: ${active?.name ?? active?.value ?? model.currentValue}. Change model`} title="Choose model" aria-expanded={open} onClick={() => { setSearch(""); setOpen(!open); }}>
          <Icon name="bolt" size={14} /> {active?.name ?? active?.value ?? model.currentValue} <span aria-hidden="true">⌄</span>
        </button>
        {open && <div className="model-picker" data-testid="model-picker" role="dialog" aria-label="Choose model">
          <div className="model-picker-title">Choose a model</div>
          <input autoFocus data-testid="model-search" aria-label="Search models" placeholder="Search models…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }} />
          <div className="model-picker-list">
            {choices.map((choice) => <button key={choice.value} className={`model-choice ${choice.value === model.currentValue ? "selected" : ""}`} data-testid="model-choice" onClick={() => { onSelect(model.id, choice.value); setOpen(false); }}>
              <span><strong>{choice.name || choice.value}</strong></span>
              {choice.value === model.currentValue && <Icon name="check" size={14} />}
            </button>)}
            {!choices.length && <p className="muted">No matching models</p>}
          </div>
          <p className="muted small">Context is selected automatically from available model information.</p>
        </div>}
      </div>}
      {model && <Suspense fallback={null}><ThinkingControl option={reasoning} modelName={active?.name ?? active?.value} onSelect={(v) => onSelect(reasoning!.id, v)} onModel={() => { setSearch(""); setOpen(true); }} /></Suspense>}
      {context && <ContextMeter used={context.used} max={context.max} />}
      {children}
    </div>
  );
}
