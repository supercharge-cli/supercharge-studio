import type { ChatItem } from "../acp/session";

/** A chat as markdown: user and agent turns (tools and thoughts left out), newest kept when over `max` chars. */
export function transcript(items: ChatItem[], max = Infinity): string {
  const out = items.flatMap((i) => (i.kind === "user" ? [`**You:** ${i.text}`] : i.kind === "agent" ? [`**Agent:** ${i.text}`] : [])).join("\n\n");
  return out.length > max ? `…${out.slice(out.length - max)}` : out;
}

/** `@chat:<id>` mentions in a message. */
export const chatMentions = (text: string) => [...new Set([...text.matchAll(/(?:^|\s)@chat:([\w-]+)/g)].map((m) => m[1]))];
