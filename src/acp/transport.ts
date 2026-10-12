/**
 * Transports carry raw JSON-RPC text. WebSocket is primary; stdio is provided
 * by the desktop shell (see src/acp/tauriStdio.ts).
 */
export interface Transport {
  open(): Promise<void>;
  send(data: string): void;
  close(): void;
  onMessage: (data: string) => void;
  onClose: (reason?: string) => void;
}

export type WebSocketCtor = new (url: string) => WebSocket;

export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  onMessage: (data: string) => void = () => {};
  onClose: (reason?: string) => void = () => {};

  constructor(
    private url: string,
    private Ctor: WebSocketCtor = globalThis.WebSocket as WebSocketCtor,
  ) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new this.Ctor(this.url);
      this.ws = ws;
      const timer = setTimeout(() => {
        if (opened) return;
        reject(new Error("Timed out connecting to the agent"));
        try { ws.close(); } catch { /* ignore */ }
      }, 5000);
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        if (!opened) reject(new Error("Can’t reach the agent yet"));
      };
      ws.onclose = (ev: CloseEvent) => {
        if (this.ws === ws) this.ws = null;
        if (!opened) reject(new Error(`WebSocket closed before open (${ev?.code ?? "?"})`));
        else this.onClose(ev?.reason || String(ev?.code ?? ""));
      };
      ws.onmessage = (ev: MessageEvent) => {
        const d = ev.data;
        if (typeof d === "string") this.onMessage(d);
        else if (d instanceof ArrayBuffer) this.onMessage(new TextDecoder().decode(d));
        else this.onMessage(String(d));
      };
    });
  }

  send(data: string) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error("Not connected");
    this.ws.send(data);
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
