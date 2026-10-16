/**
 * Local full-text index of chat titles and messages. Stored in localStorage as one compact
 * record per chat; a chat is re-indexed only when its message count / last text changes.
 */
export type IndexedMsg = { i: number; role: "user" | "agent"; text: string };
export type ChatDoc = { chatId: string; title: string; project: string; updatedAt: number; sig: string; msgs: IndexedMsg[] };
export type Hit = { chatId: string; title: string; project: string; updatedAt: number; msgIndex: number | null; snippet: { before: string; match: string; after: string }; score: number };

const KEY = "supercharge-studio/search-v1";
const MAX_MSG = 4000; // chars kept per message
const MAX_CHAT_MSGS = 2000;

export const norm = (s: string) => s.toLowerCase();
export const sigOf = (msgs: { text: string }[]) => `${msgs.length}:${msgs.length ? msgs[msgs.length - 1].text.length : 0}`;

export class SearchIndex {
  docs = new Map<string, ChatDoc>();
  private lower = new Map<string, string[]>();
  constructor(private storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage !== "undefined" ? localStorage : null) {
    try { const raw = this.storage?.getItem(KEY); if (raw) for (const d of JSON.parse(raw) as ChatDoc[]) this.put(d, false); } catch { /* corrupt: start fresh */ }
  }
  private put(d: ChatDoc, persist = true) {
    this.docs.set(d.chatId, d);
    this.lower.set(d.chatId, d.msgs.map((m) => norm(m.text)));
    if (persist) this.persist();
  }
  private timer: any = 0;
  private persist() {
    if (!this.storage || this.timer) return;
    this.timer = setTimeout(() => { this.timer = 0; try { this.storage!.setItem(KEY, JSON.stringify([...this.docs.values()])); } catch { /* quota */ } }, 500);
  }
  flushNow() { if (this.timer) { clearTimeout(this.timer); this.timer = 0; } try { this.storage?.setItem(KEY, JSON.stringify([...this.docs.values()])); } catch { /* quota */ } }
  /** Incremental: returns true when the chat changed and was re-indexed. */
  upsert(meta: { chatId: string; title: string; project: string; updatedAt: number }, items: { kind: string; text?: string }[] | null): boolean {
    const old = this.docs.get(meta.chatId);
    if (!items) {
      if (old && old.title === meta.title && old.project === meta.project && old.updatedAt === meta.updatedAt) return false;
      this.put({ ...(old ?? { msgs: [], sig: "" }), ...meta });
      return true;
    }
    const msgs: IndexedMsg[] = [];
    items.forEach((it, i) => { if ((it.kind === "user" || it.kind === "agent") && it.text) msgs.push({ i, role: it.kind, text: it.text.slice(0, MAX_MSG) }); });
    if (msgs.length > MAX_CHAT_MSGS) msgs.splice(0, msgs.length - MAX_CHAT_MSGS);
    const sig = sigOf(msgs);
    if (old && old.sig === sig && old.title === meta.title && old.project === meta.project) return false;
    if (!msgs.length && old?.msgs.length) return false; // not loaded yet: keep what we had
    this.put({ ...meta, sig, msgs });
    return true;
  }
  remove(chatId: string) { if (this.docs.delete(chatId)) { this.lower.delete(chatId); this.persist(); } }
  search(q: string, limit = 50): Hit[] { return searchDocs([...this.docs.values()], q, limit, this.lower); }
}

export function snippet(text: string, at: number, len: number, radius = 50) {
  const s = Math.max(0, at - radius), e = Math.min(text.length, at + len + radius);
  return { before: (s > 0 ? "…" : "") + text.slice(s, at).replace(/\s+/g, " "), match: text.slice(at, at + len), after: text.slice(at + len, e).replace(/\s+/g, " ") + (e < text.length ? "…" : "") };
}

/**
 * Ranking: whole query phrase > all terms. Title matches weigh most, then user messages;
 * newer chats win ties. One hit per chat (its best message).
 */
export function searchDocs(docs: ChatDoc[], q: string, limit = 50, lowerCache?: Map<string, string[]>): Hit[] {
  const phrase = norm(q.trim());
  if (phrase.length < 2) return [];
  const terms = phrase.split(/\s+/).filter(Boolean);
  const now = Date.now();
  const hits: Hit[] = [];
  for (const d of docs) {
    const tl = norm(d.title);
    let best: Hit | null = null;
    let bestMsg: Hit | null = null;
    const consider = (score: number, msgIndex: number | null, text: string, at: number, len: number) => {
      if (msgIndex != null && (!bestMsg || score > bestMsg.score)) bestMsg = { chatId: d.chatId, title: d.title, project: d.project, updatedAt: d.updatedAt, msgIndex, snippet: snippet(text, at, len), score };
      if (!best || score > best.score) best = { chatId: d.chatId, title: d.title, project: d.project, updatedAt: d.updatedAt, msgIndex, snippet: snippet(text, at, len), score };
    };
    if (tl.includes(phrase)) consider(100 + (tl.startsWith(phrase) ? 10 : 0), null, d.title, tl.indexOf(phrase), phrase.length);
    else if (terms.length > 1 && terms.every((t) => tl.includes(t))) consider(60, null, d.title, tl.indexOf(terms[0]), terms[0].length);
    const lows = lowerCache?.get(d.chatId) ?? d.msgs.map((m) => norm(m.text));
    for (let k = 0; k < d.msgs.length; k++) {
      const lt = lows[k], m = d.msgs[k];
      const role = m.role === "user" ? 8 : 0;
      const at = lt.indexOf(phrase);
      if (at >= 0) {
        let count = 0; for (let p = at; p >= 0 && count < 5; p = lt.indexOf(phrase, p + phrase.length)) count++;
        consider(40 + role + count * 2 + (/\w/.test(lt[at - 1] ?? "") ? 0 : 4), m.i, m.text, at, phrase.length);
      } else if (terms.length > 1 && terms.every((t) => lt.includes(t))) {
        const a = lt.indexOf(terms[0]);
        consider(20 + role, m.i, m.text, a, terms[0].length);
      }
    }
    if (best && bestMsg && (best as Hit).msgIndex == null) {
      // Title hit: still open at (and show) the best matching message.
      const m = bestMsg as Hit;
      (best as Hit).msgIndex = m.msgIndex;
      (best as Hit).snippet = m.snippet;
    }
    if (best) {
      const b = best as Hit;
      b.score += Math.max(0, 5 - (now - d.updatedAt) / 86400000 / 7); // up to +5 for the last weeks
      hits.push(b);
    }
  }
  return hits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt).slice(0, limit);
}
