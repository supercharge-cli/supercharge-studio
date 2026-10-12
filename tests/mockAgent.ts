import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "net";

export type Handler = (msg: any, sock: WebSocket, agent: MockAgent) => void;

/** Minimal in-process ACP agent over WebSocket for tests. */
export class MockAgent {
  wss!: WebSocketServer;
  port = 0;
  sockets: WebSocket[] = [];
  received: any[] = [];
  handlers = new Map<string, Handler>();
  connections = 0;

  async start(port = 0) {
    this.wss = new WebSocketServer({ port, host: "127.0.0.1", verifyClient: (info: any) => !!info.req.url?.includes("server-key=secret") });
    await new Promise<void>((r) => this.wss.once("listening", () => r()));
    this.port = (this.wss.address() as AddressInfo).port;
    this.wss.on("connection", (sock) => {
      this.connections++;
      this.sockets.push(sock);
      sock.on("message", (data) => {
        const msg = JSON.parse(String(data));
        this.received.push(msg);
        const h = msg.method ? this.handlers.get(msg.method) : undefined;
        if (h) h(msg, sock, this);
      });
    });
    this.on("initialize", (m, s) =>
      reply(s, m.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, _meta: { supercharge: { methods: ["supercharge/fs/tree", "_supercharge/git/status"] } } },
      }),
    );
    this.on("session/new", (m, s) => reply(s, m.id, { sessionId: "sess-1" }));
    return this;
  }

  get url() {
    return `ws://127.0.0.1:${this.port}/ws?server-key=secret`;
  }
  on(method: string, h: Handler) {
    this.handlers.set(method, h);
  }
  dropAll() {
    this.sockets.forEach((s) => s.terminate());
    this.sockets = [];
  }
  async stop() {
    this.dropAll();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

export const reply = (s: WebSocket, id: any, result: any) => s.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
export const send = (s: WebSocket, msg: any) => s.send(JSON.stringify({ jsonrpc: "2.0", ...msg }));
export const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("until timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};
