import { describe, expect, it } from "vitest";
import { fitSize, needsResize, outputType, MAX_DIM } from "../src/lib/imageResize";
import { Deduper, shouldNotify, notifyTitle, clip } from "../src/lib/notify";
import { SearchIndex, searchDocs, snippet, type ChatDoc } from "../src/lib/searchIndex";

describe("image downscale sizing", () => {
  it("fits the long edge to the max and keeps aspect", () => {
    expect(fitSize(4000, 3000)).toEqual({ w: 2000, h: 1500, scaled: true });
    expect(fitSize(1200, 5000)).toEqual({ w: 480, h: 2000, scaled: true });
  });
  it("never upscales", () => expect(fitSize(800, 600)).toEqual({ w: 800, h: 600, scaled: false }));
  it("handles bad input", () => expect(fitSize(0, 10).w).toBe(0));
  it("decides when to re-encode", () => {
    expect(needsResize("image/png", 3000, 100, 1000)).toBe(true);
    expect(needsResize("image/jpeg", 1000, 800, 3 * 1024 * 1024)).toBe(true);
    expect(needsResize("image/jpeg", 1000, 800, 200_000)).toBe(false);
    expect(needsResize("image/gif", 5000, 5000, 9e6)).toBe(false);
    expect(MAX_DIM).toBe(2000);
  });
  it("picks WebP for PNG and JPEG for photos", () => {
    expect(outputType("image/png")).toBe("image/webp");
    expect(outputType("image/jpeg")).toBe("image/jpeg");
  });
});

describe("notification gating", () => {
  const prefs = { done: true, error: true, permission: true, sound: true };
  it("stays quiet when the user is looking at that chat", () =>
    expect(shouldNotify("done", prefs, { focused: true, visible: true, activeChatId: "a", chatId: "a" })).toBe(false));
  it("notifies when unfocused or hidden", () => {
    expect(shouldNotify("done", prefs, { focused: false, visible: true, activeChatId: "a", chatId: "a" })).toBe(true);
    expect(shouldNotify("error", prefs, { focused: true, visible: false, activeChatId: "a", chatId: "a" })).toBe(true);
  });
  it("notifies when another chat is open", () =>
    expect(shouldNotify("permission", prefs, { focused: true, visible: true, activeChatId: "b", chatId: "a" })).toBe(true));
  it("respects per-event toggles; defaults on", () => {
    expect(shouldNotify("done", { ...prefs, done: false }, { focused: false, visible: false, chatId: "a" })).toBe(false);
    expect(shouldNotify("permission", undefined, { focused: false, visible: false, chatId: "a" })).toBe(true);
  });
  it("dedupes bursts per key", () => {
    let t = 0;
    const d = new Deduper(1000, () => t);
    expect(d.ok("a")).toBe(true);
    expect(d.ok("a")).toBe(false);
    expect(d.ok("b")).toBe(true);
    t = 1500;
    expect(d.ok("a")).toBe(true);
  });
  it("titles and clips", () => {
    expect(notifyTitle("permission", "Fix bug")).toMatch(/approval.*Fix bug/);
    expect(clip("x".repeat(300), 10)).toHaveLength(10);
  });
});

const doc = (chatId: string, title: string, msgs: [string, "user" | "agent"][], updatedAt = Date.now()): ChatDoc =>
  ({ chatId, title, project: "p", updatedAt, sig: "", msgs: msgs.map(([text, role], i) => ({ i, role, text })) });

describe("session search", () => {
  it("ranks title matches above message matches", () => {
    const hits = searchDocs([doc("a", "misc", [["we fixed the login bug", "agent"]]), doc("b", "Login bug", [])], "login bug");
    expect(hits.map((h) => h.chatId)).toEqual(["b", "a"]);
    expect(hits[1].msgIndex).toBe(0);
    const t = searchDocs([doc("c", "zebra notes", [["intro", "agent"], ["the zebra lives here", "user"]])], "zebra")[0];
    expect(t.msgIndex).toBe(1);
  });
  it("prefers user messages and newer chats on ties", () => {
    const old = Date.now() - 90 * 86400000;
    const hits = searchDocs([doc("a", "x", [["deploy script", "agent"]]), doc("b", "y", [["deploy script", "user"]], old)], "deploy");
    expect(hits[0].chatId).toBe("b");
    const tie = searchDocs([doc("o", "x", [["deploy", "agent"]], old), doc("n", "y", [["deploy", "agent"]])], "deploy");
    expect(tie[0].chatId).toBe("n");
  });
  it("matches all terms in any order", () => {
    const hits = searchDocs([doc("a", "t", [["the cache is stale after rebuild", "agent"]])], "rebuild cache");
    expect(hits).toHaveLength(1);
  });
  it("builds a highlighted snippet", () => {
    const sn = snippet("a".repeat(100) + "NEEDLE" + "b".repeat(100), 100, 6, 10);
    expect(sn.match).toBe("NEEDLE");
    expect(sn.before.startsWith("…")).toBe(true);
    expect(sn.after.endsWith("…")).toBe(true);
    const h = searchDocs([doc("a", "t", [["Find the Needle here", "user"]])], "needle")[0];
    expect(h.snippet.match).toBe("Needle");
  });
  it("indexes incrementally and persists", () => {
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const ix = new SearchIndex(st);
    const meta = { chatId: "c", title: "Chat", project: "p", updatedAt: 1 };
    expect(ix.upsert(meta, [{ kind: "user", text: "hello world" }, { kind: "tool" }])).toBe(true);
    expect(ix.upsert(meta, [{ kind: "user", text: "hello world" }, { kind: "tool" }])).toBe(false);
    expect(ix.upsert(meta, [])).toBe(false); // not loaded: keep old messages
    ix.flushNow();
    const again = new SearchIndex(st);
    expect(again.search("hello")[0].chatId).toBe("c");
  });
  it("is fast for thousands of messages", () => {
    const docs = Array.from({ length: 300 }, (_, c) => doc(`c${c}`, `chat ${c}`, Array.from({ length: 20 }, (_, m) => [`message ${m} about topic ${c * 20 + m} with some filler text to search through`, m % 2 ? "agent" : "user"] as [string, "user" | "agent"])));
    const t = performance.now();
    const hits = searchDocs(docs, "topic 5999");
    expect(performance.now() - t).toBeLessThan(200);
    expect(hits[0].chatId).toBe("c299");
  });
  it("ignores 1-char queries", () => expect(searchDocs([doc("a", "a", [])], "a")).toEqual([]));
});

import { GatewayHub } from "../src/gateway/hub";
describe("gateway forwards agent alerts to phones", () => {
  it("broadcasts _supercharge/agent_event to every paired device", () => {
    const sent: [string, any][] = [];
    const hub = new GatewayHub((d, m) => void sent.push([d, m]), {} as any);
    hub.connected("phone1");
    hub.connected("phone2");
    sent.length = 0;
    hub.agentEvent("s1", "permission", "Allow: run tests?");
    expect(sent.map(([d]) => d).sort()).toEqual(["phone1", "phone2"]);
    expect(sent[0][1]).toMatchObject({ method: "_supercharge/agent_event", params: { sessionId: "s1", kind: "permission" } });
  });
});
