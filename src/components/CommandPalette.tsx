import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";

export type Command = { id: string; title: string; hint?: string; icon?: string; group?: string; run: () => void };

/** Fuzzy subsequence score (higher is better), -1 if no match. */
export function score(q: string, s: string): number {
  q = q.toLowerCase();
  s = s.toLowerCase();
  if (!q) return 0;
  let i = 0, sc = 0, prev = -2;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) {
      sc += j === prev + 1 ? 3 : 1;
      if (j === 0 || /[\s/·-]/.test(s[j - 1])) sc += 2;
      prev = j;
      i++;
    }
  }
  return i === q.length ? sc : -1;
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(
    () => commands.map((c) => ({ c, s: score(q, `${c.title} ${c.hint ?? ""}`) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 50).map((x) => x.c),
    [commands, q],
  );
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setSel(0), [q]);
  const run = (c?: Command) => {
    if (!c) return;
    onClose();
    c.run();
  };
  return (
    <div className="palette-bg" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()} data-testid="palette">
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={input}
            value={q}
            placeholder="Type a command or search chats…"
            data-testid="palette-input"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(list.length - 1, s + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); run(list[sel]); }
              else if (e.key === "Escape") { e.preventDefault(); onClose(); }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list">
          {list.length === 0 && <div className="muted palette-empty">No matches</div>}
          {list.map((c, i) => (
            <button key={c.id} className={`palette-item ${i === sel ? "on" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
              <Icon name={c.icon ?? "command"} size={15} />
              <span className="pi-title">{c.title}</span>
              {c.group && <span className="pi-group">{c.group}</span>}
              {c.hint && <kbd>{c.hint}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
