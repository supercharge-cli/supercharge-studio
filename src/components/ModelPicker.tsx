import { useState } from "react";
import type { ConfigOption } from "../acp/types";
import { Icon } from "./Icon";
import { ModelCustomForm } from "./ModelCustomForm";

export function ModelPicker({ model, onSelect, onCustom, onClose }: {
  model: ConfigOption;
  onSelect: (id: string, value: string) => void;
  onCustom?: (id: string, name?: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [custom, setCustom] = useState(false);
  const [customId, setCustomId] = useState("");
  const [customName, setCustomName] = useState("");
  const q = search.toLowerCase();
  const choices = (model.options ?? []).filter((c) => `${c.name ?? ""} ${c.value}`.toLowerCase().includes(q));
  const apply = () => {
    const id = customId.trim();
    if (!id) return;
    const name = customName.trim() || undefined;
    onCustom?.(id, name);
    onSelect(model.id, id);
    onClose();
  };
  return (
    <div className="model-picker" data-testid="model-picker" role="dialog" aria-label="Choose model">
      <div className="model-picker-title">Model</div>
      {!custom && <input autoFocus data-testid="model-search" aria-label="Search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }} />}
      <div className="model-picker-list">
        {!custom && choices.map((c) => (
          <button key={c.value} className={`model-choice ${c.value === model.currentValue ? "selected" : ""}`} data-testid="model-choice" onClick={() => { onSelect(model.id, c.value); onClose(); }}>
            <span><strong>{c.name || c.value}</strong></span>
            {c.value === model.currentValue && <Icon name="check" size={14} />}
          </button>
        ))}
        {!custom && !choices.length && <p className="muted">No matches</p>}
        {!custom && <button type="button" className="model-choice" data-testid="model-custom-toggle" onClick={() => { setCustom(true); setCustomId(search.trim()); setCustomName(""); }}>
          <span><strong>Enter model id…</strong><small>Custom id</small></span>
        </button>}
        {custom && <ModelCustomForm id={customId} name={customName} onId={setCustomId} onName={setCustomName} onBack={() => setCustom(false)} onSave={apply} />}
      </div>
      <p className="muted small">Context follows the model.</p>
    </div>
  );
}
