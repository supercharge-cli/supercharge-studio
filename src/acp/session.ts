/** Pure reducer turning ACP session/update notifications into UI state. */
import type { ContentBlock, PlanEntry, SessionUpdate, ToolCall } from "./types";

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; toolCallId: string }
  | { kind: "system"; text: string };

export type SessionState = {
  items: ChatItem[];
  toolCalls: Record<string, ToolCall>;
  plan: PlanEntry[];
  commands: { name: string; description?: string }[];
  modeId?: string;
  title?: string;
};

export const emptySession = (): SessionState => ({ items: [], toolCalls: {}, plan: [], commands: [] });

export function blockText(c: ContentBlock | undefined): string {
  if (!c) return "";
  if (c.type === "text") return String((c as any).text ?? "");
  if (c.type === "resource_link") return `[${(c as any).name ?? (c as any).uri}]`;
  if (c.type === "resource") return String((c as any).resource?.text ?? (c as any).resource?.uri ?? "");
  if (c.type === "image") return "[image]";
  return "";
}

function appendText(items: ChatItem[], kind: "user" | "agent" | "thought", text: string): ChatItem[] {
  if (!text) return items;
  const last = items[items.length - 1];
  if (last && last.kind === kind) {
    const copy = items.slice();
    copy[copy.length - 1] = { kind, text: last.text + text };
    return copy;
  }
  return [...items, { kind, text }];
}

export function applyUpdate(s: SessionState, u: SessionUpdate): SessionState {
  const x = u as any;
  switch (u.sessionUpdate) {
    case "user_message_chunk":
      return { ...s, items: appendText(s.items, "user", blockText(x.content)) };
    case "agent_message_chunk":
      return { ...s, items: appendText(s.items, "agent", blockText(x.content)) };
    case "agent_thought_chunk":
      return { ...s, items: appendText(s.items, "thought", blockText(x.content)) };
    case "tool_call": {
      const id = String(x.toolCallId);
      const tc: ToolCall = {
        toolCallId: id,
        title: x.title ?? x.kind ?? "tool",
        kind: x.kind,
        status: x.status ?? "pending",
        content: x.content ?? [],
        locations: x.locations ?? [],
        rawInput: x.rawInput,
        rawOutput: x.rawOutput,
      };
      const exists = !!s.toolCalls[id];
      return {
        ...s,
        toolCalls: { ...s.toolCalls, [id]: exists ? { ...s.toolCalls[id], ...tc } : tc },
        items: exists ? s.items : [...s.items, { kind: "tool", toolCallId: id }],
      };
    }
    case "tool_call_update": {
      const id = String(x.toolCallId);
      const prev: ToolCall =
        s.toolCalls[id] ?? { toolCallId: id, title: x.title ?? "tool", status: "pending", content: [], locations: [] };
      const next: ToolCall = { ...prev };
      for (const k of ["title", "kind", "status", "content", "locations", "rawInput", "rawOutput"] as const) {
        if (x[k] !== undefined && x[k] !== null) (next as any)[k] = x[k];
      }
      return {
        ...s,
        toolCalls: { ...s.toolCalls, [id]: next },
        items: s.toolCalls[id] ? s.items : [...s.items, { kind: "tool", toolCallId: id }],
      };
    }
    case "plan":
      return { ...s, plan: Array.isArray(x.entries) ? x.entries : [] };
    case "available_commands_update":
      return { ...s, commands: Array.isArray(x.availableCommands) ? x.availableCommands : [] };
    case "session_info_update":
      return typeof x.title === "string" && x.title ? { ...s, title: x.title } : s;
    case "current_mode_update":
      return { ...s, modeId: x.currentModeId };
    default:
      return s;
  }
}

/** Heuristic: tool calls that look like browser / web activity. */
export function isBrowserTool(tc: ToolCall): boolean {
  const t = `${tc.kind ?? ""} ${tc.title}`.toLowerCase();
  return tc.kind === "fetch" || /browser|navigate|screenshot|web|url|page|click/.test(t);
}
