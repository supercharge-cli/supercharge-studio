import { useEffect, useRef } from "react";
import type { MenuItem } from "../lib/composer";
import { Icon } from "./Icon";

/** Pop-up list above the composer. Keyboard handling lives in the composer (it keeps focus). */
export function ComposerMenu({ items, sel, title, empty, onPick, onHover }: { items: MenuItem[]; sel: number; title?: string; empty?: string; onPick: (it: MenuItem) => void; onHover: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel, items]);
  let lastGroup: string | undefined;
  return (
    <div className="cmenu" ref={ref} role="listbox" aria-label={title ?? "Suggestions"} data-testid="composer-menu" onMouseDown={(e) => e.preventDefault()}>
      {title && <div className="cmenu-title">{title}</div>}
      {items.length === 0 && <div className="cmenu-empty muted">{empty ?? "No matches"}</div>}
      {items.map((it, i) => {
        const head = it.group && it.group !== lastGroup ? <div className="cmenu-group" key={`g-${it.group}`}>{it.group}</div> : null;
        lastGroup = it.group;
        return [
          head,
          <button
            key={it.id}
            data-i={i}
            role="option"
            aria-selected={i === sel}
            className={`cmenu-item ${i === sel ? "sel" : ""}`}
            data-testid="composer-menu-item"
            onMouseMove={() => i !== sel && onHover(i)}
            onClick={() => onPick(it)}
          >
            {it.icon && <Icon name={it.icon as any} size={14} />}
            <b>{it.label}</b>
            {it.detail && <span>{it.detail}</span>}
          </button>,
        ];
      })}
    </div>
  );
}
