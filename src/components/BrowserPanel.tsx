import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { browser } from "../browser/bridge";
import { isDesktop } from "../lib/desktop";
import type { ToolCall } from "../acp/types";
import { ToolCard } from "./ToolCard";

/** Right panel: side browser (native child webview on desktop) + live tool calls. */
export function BrowserPanel({ tools, onClose }: { tools: ToolCall[]; onClose: () => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(browser.url === "about:blank" ? "https://superchargeai.in" : browser.url);
  const [tab, setTab] = useState<"browser" | "tools">("browser");

  useEffect(() => {
    const l = (u: string) => setUrl(u);
    browser.listeners.add(l);
    return () => void browser.listeners.delete(l);
  }, []);

  // Keep the native webview glued to the placeholder div.
  useLayoutEffect(() => {
    const el = slot.current;
    if (!el || tab !== "browser") {
      void browser.hide();
      return;
    }
    const rect = () => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) };
    };
    void browser.open(url, rect()).catch(() => {});
    const ro = new ResizeObserver(() => void browser.setBounds(rect()));
    ro.observe(el);
    window.addEventListener("resize", () => void browser.setBounds(rect()));
    return () => {
      ro.disconnect();
      void browser.hide();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <aside className="rpanel">
      <div className="tabs">
        <button className={tab === "browser" ? "on" : ""} onClick={() => setTab("browser")}>Browser</button>
        <button className={tab === "tools" ? "on" : ""} onClick={() => setTab("tools")}>Tools ({tools.length})</button>
        <div style={{ flex: 1 }} />
        <button className="icon" onClick={onClose} title="Close panel">×</button>
      </div>
      {tab === "browser" ? (
        <>
          <form
            className="urlbar"
            onSubmit={(e) => {
              e.preventDefault();
              void browser.navigate(url);
            }}
          >
            <input value={url} onChange={(e) => setUrl(e.target.value)} />
          </form>
          <div ref={slot} className="webslot">
            {!isDesktop() && <iframe title="browser" src={url} sandbox="allow-scripts allow-forms allow-same-origin" />}
          </div>
        </>
      ) : (
        <div className="toollist">
          {tools.length === 0 && <div className="muted pad">Tool calls from the agent appear here.</div>}
          {tools.map((t) => <ToolCard key={t.toolCallId} tc={t} compact />)}
        </div>
      )}
    </aside>
  );
}
