import { clip } from "./notify";

/** What a running turn is doing right now, for the phone's ongoing notification. */
type Tool = { title?: string; kind?: string; path?: string };
const EDITS = ["edit", "delete", "move"];
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Status line for one session update, or undefined when it doesn't change what the agent is doing. */
export function liveText(u: any, tools: Map<string, Tool>): string | undefined {
  const k = u?.sessionUpdate;
  if (k === "agent_thought_chunk") return "Thinking…";
  if (k === "agent_message_chunk") return "Writing the reply…";
  if (k !== "tool_call" && k !== "tool_call_update") return;
  const id = String(u.toolCallId ?? ""), t: Tool = { ...tools.get(id) };
  if (u.title) t.title = String(u.title);
  if (u.kind) t.kind = String(u.kind);
  const p = u.locations?.[0]?.path ?? u.content?.find?.((c: any) => c?.type === "diff")?.path;
  if (p) t.path = String(p);
  if (u.status === "completed" || u.status === "failed") { tools.delete(id); return "Working…"; }
  tools.set(id, t);
  if (EDITS.includes(t.kind ?? "")) return t.path ? `Editing ${base(t.path)}` : "Editing file";
  return `Running: ${clip(t.title || "a tool", 60)}`;
}

export const approvalText = (title?: string) => `Waiting for approval: ${clip(title || "a tool call", 80)}`;
