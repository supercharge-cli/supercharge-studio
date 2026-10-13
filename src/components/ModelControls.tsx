import { useState } from "react";
import type { ConfigOption } from "../acp/types";
import { optionFor } from "../lib/sessionOptions";
import { Icon } from "./Icon";

export function ModelControls({ options, onSelect }: { options: ConfigOption[]; onSelect: (id: string, value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const model = optionFor(options, "model");
  const reasoning = optionFor(options, "reasoning_effort");
  const active = model?.options?.find((choice) => choice.value === model.currentValue);
  if (!model) return null;
  const choices = model.options!.filter((choice) => `${choice.name ?? ""} ${choice.value}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="model-controls">
      <div className="model-menu-anchor">
        <button className="secondary model-trigger" data-testid="model-trigger" aria-expanded={open} onClick={() => { setSearch(""); setOpen(!open); }}>
          <Icon name="bolt" size={14} /> {active?.name ?? active?.value ?? model.currentValue} <span aria-hidden="true">⌄</span>
        </button>
        {open && <div className="model-picker" data-testid="model-picker" role="dialog" aria-label="Choose model">
          <div className="model-picker-title">Choose a model</div>
          <input autoFocus data-testid="model-search" aria-label="Search models" placeholder="Search models…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }} />
          <div className="model-picker-list">
            {choices.map((choice) => <button key={choice.value} className={`model-choice ${choice.value === model.currentValue ? "selected" : ""}`} data-testid="model-choice" onClick={() => { onSelect(model.id, choice.value); setOpen(false); }}>
              <span><strong>{choice.name ?? choice.value}</strong>{choice.name && choice.name !== choice.value && <small>{choice.value}</small>}</span>
              {choice.value === model.currentValue && <Icon name="check" size={14} />}
            </button>)}
            {!choices.length && <p className="muted">No matching models</p>}
          </div>
          <p className="muted small">Context is selected automatically from available model information.</p>
        </div>}
      </div>
      {reasoning && <label className="model-reasoning">Thinking
        <select aria-label="Thinking level" data-testid="thinking-level" value={reasoning.currentValue} onChange={(e) => onSelect(reasoning.id, e.target.value)}>
          {reasoning.options!.map((choice) => <option key={choice.value} value={choice.value}>{choice.name ?? choice.value}</option>)}
        </select>
      </label>}
    </div>
  );
}
