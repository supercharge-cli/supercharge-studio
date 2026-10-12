/** ACP stdio transport: `supercharge agent stdio` spawned by the desktop shell (NDJSON). */
import type { Transport } from "./transport";
import { invoke, listen } from "../lib/desktop";

export class StdioTransport implements Transport {
  onMessage: (data: string) => void = () => {};
  onClose: (reason?: string) => void = () => {};
  private unlisten: (() => void)[] = [];

  constructor(private alwaysApprove = true) {}

  async open() {
    this.unlisten.push(await listen<string>("acp-stdio://line", (l) => this.onMessage(l)));
    this.unlisten.push(await listen("acp-stdio://closed", () => this.onClose("stdio exited")));
    await invoke("stdio_start", { alwaysApprove: this.alwaysApprove });
  }
  send(data: string) {
    void invoke("stdio_send", { line: data });
  }
  close() {
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
    void invoke("stdio_stop").catch(() => {});
  }
}
