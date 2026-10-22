/** User-added MCP servers, passed to the agent with every session (ACP `mcpServers`). */
export type McpServer = { name: string; on: boolean; url?: string; command?: string; args?: string; env?: string };

const pairs = (s = "", sep: string) =>
  s.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(sep); return i > 0 ? { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() } : null; }).filter((x): x is { name: string; value: string } => !!x);
/** Split args like a shell would for simple quoting: `-y "my dir" x`. */
export const splitArgs = (s = "") => [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

/** ACP mcpServers entries for the enabled servers; HTTP ones only when the agent supports them. */
export function acpServers(list: McpServer[] | undefined, http: boolean): unknown[] {
  return (list ?? []).filter((s) => s.on && s.name.trim()).flatMap((s): unknown[] =>
    s.url ? (http ? [{ type: "http", name: s.name.trim(), url: s.url.trim(), headers: pairs(s.env, ":") }] : [])
      : s.command?.trim() ? [{ name: s.name.trim(), command: s.command.trim(), args: splitArgs(s.args), env: pairs(s.env, "=") }] : []);
}
