import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

/** `${chat}|${index of the thought streaming right now, or -1}`; a string so unchanged turns don't re-render rows. */
export const ThoughtLive = createContext("|-1");

// Survive virtualised remounts: how long each thought took, and the user's own open/closed pick.
const took = new Map<string, number>();
const picked = new Map<string, boolean>();

export function thoughtLabel(live: boolean, secs?: number): string {
  return live ? "Thinking…" : secs != null ? `Thought for ${Math.max(1, secs)}s` : "Thought";
}

/** Reasoning block: open and streaming while the agent thinks, then folds to "Thought for Ns" unless the user chose otherwise. */
export function Thought({ text, index }: { text: string; index: number }) {
  const [chat, at] = useContext(ThoughtLive).split("|");
  const live = Number(at) === index;
  const id = `${chat}:${index}`;
  const [mine, setMine] = useState<boolean | undefined>(() => picked.get(id));
  const start = useRef<number | undefined>(undefined);
  const [, done] = useState(0);
  useEffect(() => {
    if (live) { start.current ??= Date.now(); return; }
    if (start.current != null) { took.set(id, Math.round((Date.now() - start.current) / 1000)); start.current = undefined; done((n) => n + 1); }
  }, [live, id]);
  const open = mine ?? live;
  const toggle = () => { picked.set(id, !open); setMine(!open); };
  return (
    <div className={`thought-block${live ? " live" : ""}`} data-testid="thought">
      <button type="button" className="thought-head" aria-expanded={open} data-testid="thought-toggle" onClick={toggle}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} /> <span>{thoughtLabel(live, took.get(id))}</span>
      </button>
      {open && <div className="bubble thought">{text}</div>}
    </div>
  );
}
