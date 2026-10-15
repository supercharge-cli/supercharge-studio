import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { invoke, listen } from "../lib/desktop";

/** Interactive shell for the project folder, shown in the right panel. */
export function TerminalPane({ cwd }: { cwd?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      theme: { background: "#00000000", foreground: "#e7e7ea", cursor: "#e7e7ea" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    let stopped = false;
    void invoke("term_open", { cwd: cwd || null, cols: term.cols, rows: term.rows }).catch((e) => term.writeln(`\r\n${e}`));
    const typed = term.onData((data) => { void invoke("term_write", { data }).catch(() => {}); });
    const unlisten = listen<string>("term-data", (e) => { if (!stopped) term.write(e.payload); });
    const ro = new ResizeObserver(() => {
      fit.fit();
      void invoke("term_resize", { cols: term.cols, rows: term.rows }).catch(() => {});
    });
    ro.observe(el);
    return () => {
      stopped = true;
      typed.dispose();
      ro.disconnect();
      void unlisten.then((f) => f());
      void invoke("term_close").catch(() => {});
      term.dispose();
    };
  }, [cwd]);
  return <div ref={host} className="term-host" data-testid="terminal-pane" />;
}
