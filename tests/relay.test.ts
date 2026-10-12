import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
// @ts-ignore plain JS module
import { startRelay } from "../relay/server.mjs";

const PORT = 24890;
const U = `ws://127.0.0.1:${PORT}`;
let server: any;
beforeAll(async () => { server = await startRelay(PORT, "127.0.0.1"); });
afterAll(() => server?.close());

const open = (url: string) => new Promise<WebSocket>((res, rej) => { const w = new WebSocket(url); w.once("open", () => res(w)); w.once("error", rej); });
const closed = (w: WebSocket) => new Promise<number>((res) => w.once("close", (c) => res(c)));
const next = (w: WebSocket) => new Promise<any>((res) => w.once("message", (d, bin) => res(bin ? d : JSON.parse(String(d)))));
const TOKEN = "a".repeat(64);

async function host(id: string, token = TOKEN) {
  const w = await open(`${U}/v1/host/${id}`);
  w.send(JSON.stringify({ t: "register", token }));
  return { w, reply: await next(w) };
}

describe("reference relay", () => {
  it("rejects phones when the host is offline", async () => {
    expect(await closed(await open(`${U}/v1/connect/nobody-here`))).toBe(4503);
  });
  it("binds a host id to its first token", async () => {
    const a = await host("host-tofu-1");
    expect(a.reply.t).toBe("registered");
    const b = await host("host-tofu-1", "b".repeat(64));
    expect(b.reply.t).toBe("error");
    a.w.close();
  });
  it("pipes frames verbatim between phone and host lane, queueing until attach", async () => {
    const h = await host("host-pipe-1");
    const phone = await open(`${U}/v1/connect/host-pipe-1`);
    phone.send(JSON.stringify({ t: "hello" }));
    const { lane } = await next(h.w);
    expect(await closed(await open(`${U}/v1/lane/host-pipe-1/${lane}?token=${"c".repeat(64)}`))).toBe(4403);
    const phone2 = await open(`${U}/v1/connect/host-pipe-1`);
    const { lane: lane2 } = await next(h.w);
    const l = await open(`${U}/v1/lane/host-pipe-1/${lane2}?token=${TOKEN}`);
    phone2.send(Buffer.from([1, 2, 3]));
    const got = await next(l);
    expect([...got]).toEqual([1, 2, 3]);
    l.send(Buffer.from([9]));
    expect([...(await next(phone2))]).toEqual([9]);
    phone.close(); phone2.close(); l.close(); h.w.close();
  });
});
