import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { invoke, listen } from "../lib/desktop";
import { hardenTerminalInput } from "../lib/terminalInput";

/** One local shell. Several of these can run at once; each has its own id. */
export function TerminalPane({ id, cwd, active }: { id: string; cwd?: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      minimumContrastRatio: 1,
      theme: { background: "#00000000", foreground: "#e7e7ea", cursor: "#e7e7ea" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    hardenTerminalInput(el);
    // Keep Escape and key presses inside the terminal from reaching app handlers.
    const stopBubble = (e: KeyboardEvent) => e.stopPropagation();
    el.addEventListener("keydown", stopBubble);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    let stopped = false;
    void invoke("term_open", { id, cwd: cwd || null, cols: term.cols, rows: term.rows }).catch((e) => term.writeln(`\r\n${e}`));
    const typed = term.onData((data) => { void invoke("term_write", { id, data }).catch(() => {}); });
    const unlisten = listen<{ id: string; data: string }>("term-data", (msg) => {
      if (!stopped && msg?.id === id) term.write(msg.data);
    });
    const ro = new ResizeObserver(() => {
      if (!active) return;
      fit.fit();
      void invoke("term_resize", { id, cols: term.cols, rows: term.rows }).catch(() => {});
    });
    ro.observe(el);
    return () => {
      stopped = true;
      typed.dispose();
      el.removeEventListener("keydown", stopBubble);
      ro.disconnect();
      void unlisten.then((f) => f());
      void invoke("term_close", { id }).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // A shell stays in the folder it was opened in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    fit.fit();
    term.focus();
    void invoke("term_resize", { id, cols: term.cols, rows: term.rows }).catch(() => {});
  }, [active, id]);
  return <div ref={host} className="term-host" data-testid="terminal-pane" hidden={!active} />;
}
