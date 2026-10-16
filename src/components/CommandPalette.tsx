import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";

import type { Hit } from "../lib/searchIndex";
export type Command = { id: string; title: string; hint?: string; icon?: string; group?: string; run: () => void; hit?: Hit };

const fmtDate = (t: number) => { const d = new Date(t); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" }); };

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

export function CommandPalette({ commands, onClose, searchChats, onHit, initialQuery = "" }: { commands: Command[]; onClose: () => void; searchChats?: (q: string) => Hit[]; onHit?: (h: Hit) => void; initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(
    () => {
      const cmds = commands.map((c) => ({ c, s: score(q, `${c.title} ${c.hint ?? ""}`) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, q.trim().length >= 2 && searchChats ? 8 : 50).map((x) => x.c);
      const hits: Command[] = q.trim().length >= 2 && searchChats && onHit ? searchChats(q).slice(0, 40).map((h) => ({ id: `hit-${h.chatId}`, title: h.title, icon: "chat", hit: h, run: () => onHit(h) })) : [];
      return [...cmds, ...hits];
    },
    [commands, q, searchChats, onHit],
  );
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setSel(0), [q]);
  // Close on Escape even when focus is not on the input (e.g. Playwright / stolen focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
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
              else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list">
          {list.length === 0 && <div className="muted palette-empty">No matches</div>}
          {list.map((c, i) => (
            c.hit ? (
              <button key={c.id} className={`palette-item palette-hit ${i === sel ? "on" : ""}`} data-testid="search-hit" onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
                <Icon name="chat" size={15} />
                <span className="ph-main">
                  <span className="ph-top"><span className="pi-title">{c.hit.title}</span><span className="pi-group">{c.hit.project}</span><span className="ph-date">{fmtDate(c.hit.updatedAt)}</span></span>
                  <span className="ph-snip">{c.hit.snippet.before}<mark>{c.hit.snippet.match}</mark>{c.hit.snippet.after}</span>
                </span>
              </button>
            ) :
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
