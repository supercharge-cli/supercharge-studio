import type { ChatItem } from "../acp/session";
import { transcript } from "./transcript";

export type Shared = { v: 1; title: string; project?: string; items: ChatItem[] };
export const SHARE_PREFIX = "supercharge-studio://import#";

export const toMarkdown = (title: string, items: ChatItem[]) => `# ${title}\n\n${transcript(items)}\n`;
export const toJson = (s: Omit<Shared, "v">) => JSON.stringify({ v: 1, ...s, exportedAt: new Date().toISOString() }, null, 2);

/** Only the readable turns travel in a share link (no tool payloads). */
const slim = (items: ChatItem[]) => items.filter((i) => i.kind === "user" || i.kind === "agent").map((i) => ({ kind: i.kind, text: (i as any).text }));

const b64u = (b: Uint8Array) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const pipe = async (b: Uint8Array, t: CompressionStream | DecompressionStream) => new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(t)).arrayBuffer());

/** A compressed, self-contained link to a read-only copy of the chat. Paste it into Studio to open it. */
export async function shareLink(title: string, items: ChatItem[], project?: string): Promise<string> {
  const json = JSON.stringify({ v: 1, title, project, items: slim(items) } satisfies Shared);
  return SHARE_PREFIX + b64u(await pipe(new TextEncoder().encode(json), new CompressionStream("gzip")));
}

export async function readShareLink(link: string): Promise<Shared | null> {
  if (!link.startsWith(SHARE_PREFIX)) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(await pipe(unb64u(link.slice(SHARE_PREFIX.length).trim()), new DecompressionStream("gzip"))));
    return s?.v === 1 && Array.isArray(s.items) ? { v: 1, title: String(s.title ?? "Shared chat"), project: s.project, items: slim(s.items) } : null;
  } catch { return null; }
}
