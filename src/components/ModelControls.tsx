import { lazy, Suspense, useState, type ReactNode } from "react";
import { ModelPicker } from "./ModelPicker";
import type { ConfigOption } from "../acp/types";
import { optionFor, reasoningOption } from "../lib/sessionOptions";
import { Icon } from "./Icon";
const ThinkingControl = lazy(() => import("./ThinkingControl").then((m) => ({ default: m.ThinkingControl })));
import { ContextMeter, type WindowCtl } from "./ContextMeter";

export function ModelControls({ options, onSelect, onCustom, children, context, window: win }: {
  options: ConfigOption[];
  onSelect: (id: string, value: string) => void;
  onCustom?: (id: string, name?: string) => void;
  children?: ReactNode;
  context?: { used: number; max?: number };
  window?: WindowCtl;
}) {
  const [open, setOpen] = useState(false);
  const model = optionFor(options, "model");
  const reasoning = reasoningOption(options);
  const active = model?.options?.find((choice) => choice.value === model.currentValue);
  if (!model && !reasoning && !children) return null;
  const close = () => setOpen(false);
  return (
    <div className="model-controls" data-testid="composer-chips">
      {model && <div className="model-menu-anchor" onKeyDown={(e) => { if (e.key === "Escape") close(); }}>
        <button className="secondary model-trigger" data-testid="model-trigger" aria-haspopup="dialog" aria-label="Change model" title="Model" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="bolt" size={14} /> {active?.name ?? active?.value ?? model.currentValue} <span aria-hidden="true">⌄</span>
        </button>
        {open && <ModelPicker model={model} onSelect={onSelect} onCustom={onCustom} onClose={close} />}
      </div>}
      {(model || reasoning) && <Suspense fallback={null}><ThinkingControl option={reasoning} modelName={active?.name ?? active?.value} onSelect={(v) => reasoning && onSelect(reasoning.id, v)} onModel={() => setOpen(true)} /></Suspense>}
      {context && <ContextMeter used={context.used} max={context.max} window={win} />}
      {children}
    </div>
  );
}
