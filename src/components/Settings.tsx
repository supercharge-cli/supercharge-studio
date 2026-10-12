import { ReactNode, useState } from "react";
import type { ApiFormat, Provider, Settings as S } from "../lib/store";
import { parseAgentUrl, uid } from "../lib/store";
import type { ConfigOption } from "../acp/types";
import { Icon } from "./Icon";
import { agentInfo, agentLog, type AgentInfo } from "../lib/desktop";

type Props = {
  value: S;
  configOptions: ConfigOption[];
  extensions: string[];
  desktop: boolean;
  onSave: (s: S) => void;
  onConfig: (id: string, v: string) => void;
  onClose: () => void;
  /** Store a provider API key in secure storage; resolves to the backend used. */
  onProviderKey: (id: string, key: string) => Promise<string>;
  /** Make a provider active and apply it to the agent. */
  onActivate: (p: Provider, all: Provider[]) => Promise<void>;
  /** Extra section rendered under "Devices" (mobile pairing). */
  devices?: ReactNode;
};

const SECTIONS = [
  { id: "connection", label: "Connection", icon: "plug" },
  { id: "providers", label: "Providers", icon: "server" },
  { id: "appearance", label: "Appearance", icon: "sun" },
  { id: "agent", label: "Agent", icon: "bolt" },
  { id: "devices", label: "Devices", icon: "phone" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

const FORMATS: { v: ApiFormat; label: string }[] = [
  { v: "responses", label: "Responses" },
  { v: "chat_completions", label: "Chat Completions" },
  { v: "messages", label: "Messages" },
];

function ProviderEditor({ p, desktop, onChange, onKey, onRemove }: { p: Provider; desktop: boolean; onChange: (p: Provider) => void; onKey: (k: string) => Promise<string>; onRemove: () => void }) {
  const [key, setKey] = useState("");
  const [keyState, setKeyState] = useState("");
  return (
    <div className="card" data-testid="provider-editor">
      <div className="grid2">
        <label>Name<input data-testid="prov-name" value={p.name} onChange={(e) => onChange({ ...p, name: e.target.value })} /></label>
        <label>API format
          <select data-testid="prov-format" value={p.format} onChange={(e) => onChange({ ...p, format: e.target.value as ApiFormat })}>
            {FORMATS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
          </select>
        </label>
      </div>
      <label>Base URL<input data-testid="prov-url" placeholder="https://api.example.com/v1" value={p.baseUrl} onChange={(e) => onChange({ ...p, baseUrl: e.target.value })} /></label>
      <label>Model IDs (comma separated)
        <input data-testid="prov-models" value={p.models.join(", ")} onChange={(e) => onChange({ ...p, models: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
      </label>
      <label>API key
        <div className="row">
          <input data-testid="prov-key" type="password" placeholder={desktop ? "Stored securely; leave blank to keep" : "Desktop app required"} value={key} disabled={!desktop} onChange={(e) => setKey(e.target.value)} />
          <button className="secondary" disabled={!desktop || !key} onClick={async () => { setKeyState(`Saved (${await onKey(key)})`); setKey(""); }}>Save key</button>
        </div>
      </label>
      <div className="row between">
        <span className="muted">{keyState}</span>
        <button className="ghost danger-text" onClick={onRemove}><Icon name="trash" /> Remove</button>
      </div>
    </div>
  );
}

export function SettingsScreen(props: Props & { initial?: Section }) {
  const { value, configOptions, extensions, desktop, onSave, onConfig, onClose } = props;
  const [s, set] = useState<S>({ ...value, providers: value.providers ?? [] });
  const [tab, setTab] = useState<Section>(props.initial ?? "connection");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const providers = s.providers ?? [];
  const setProviders = (ps: Provider[]) => set({ ...s, providers: ps });

  /** A pasted ws://host:port/ws?server-key=… URL fills both the address and the key. */
  const splitUrl = (text: string) => {
    const p = parseAgentUrl(text);
    if (!p.bind) return false;
    set({ ...s, bind: p.bind, ...(p.secret ? { secret: p.secret, agentChoice: "key" as const } : {}) });
    return true;
  };
  return (
    <div className="screen settings-screen" role="region" aria-label="Settings" data-testid="settings-screen">
      <nav className="screen-nav">
        <div className="screen-nav-title">Settings</div>
        {SECTIONS.map((t) => (
          <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)} data-testid={`tab-${t.id}`}>
            <Icon name={t.icon} /> {t.label}
          </button>
        ))}
      </nav>
      <div className="screen-main">
        <header className="screen-head">
          <h2>{SECTIONS.find((x) => x.id === tab)?.label}</h2>
          <div className="spacer" />
          <button className="icon" onClick={onClose} title="Close (Esc)"><Icon name="x" /></button>
        </header>
        <div className="screen-body section-anim" key={tab}>

        {tab === "connection" && (
          <div className="stack">
            <label>Transport
              <select value={s.transport} onChange={(e) => set({ ...s, transport: e.target.value as S["transport"] })}>
                <option value="ws">ACP WebSocket (agent serve)</option>
                <option value="stdio">ACP stdio (desktop only)</option>
              </select>
            </label>
            <div className="grid2">
              <label>Agent address<input value={s.bind} placeholder="127.0.0.1:2419 or ws://…/ws?server-key=…" data-testid="agent-bind" onChange={(e) => set({ ...s, bind: e.target.value })} onBlur={(e) => splitUrl(e.target.value)} onPaste={(e) => { const t = e.clipboardData.getData("text"); if (splitUrl(t)) e.preventDefault(); }} /></label>
              <label>Server key<input type="password" value={s.secret} data-testid="agent-secret" onChange={(e) => set({ ...s, secret: e.target.value, agentChoice: "key" })} onBlur={(e) => splitUrl(e.target.value)} onPaste={(e) => { const t = e.clipboardData.getData("text"); if (splitUrl(t)) e.preventDefault(); }} /></label>
            </div>
            <label className="check"><input type="checkbox" checked={s.autoStart} onChange={(e) => set({ ...s, autoStart: e.target.checked })} /> Start the agent automatically if it is not running</label>
            <label className="check"><input type="checkbox" checked={s.alwaysApprove} onChange={(e) => set({ ...s, alwaysApprove: e.target.checked })} /> Always approve tool calls</label>
            <p className="muted">{desktop ? "The server key is stored in the OS keychain." : "Web mode: settings are stored in this browser."}</p>
            {desktop && <AgentLog />}
          </div>
        )}

        {tab === "providers" && (
          <div className="stack">
            <p className="muted">Providers are written to the Supercharge agent config; the active one becomes the default model. Keys stay in secure storage.</p>
            {providers.length === 0 && <div className="empty-card">No providers yet. Add one to use your own API key.</div>}
            {providers.map((p) => (
              <div key={p.id}>
                <div className={`prov-row ${s.activeProviderId === p.id ? "active" : ""}`} data-testid="provider-row">
                  <div className="prov-main">
                    <strong>{p.name || "Untitled"}</strong>
                    <span className="muted">{p.models.join(", ") || "no models"} · {FORMATS.find((f) => f.v === p.format)?.label}</span>
                  </div>
                  {s.activeProviderId === p.id ? (
                    <span className="pill ok"><Icon name="check" size={12} /> Active</span>
                  ) : (
                    <button className="secondary" data-testid="prov-use" disabled={!!busy} onClick={async () => {
                      setBusy(p.id);
                      try {
                        await props.onActivate(p, providers);
                        set({ ...s, activeProviderId: p.id });
                      } finally {
                        setBusy("");
                      }
                    }}>{busy === p.id ? "Applying…" : "Use"}</button>
                  )}
                  <button className="icon" title="Edit" data-testid="prov-edit" onClick={() => setEditing(editing === p.id ? null : p.id)}><Icon name="edit" /></button>
                </div>
                {editing === p.id && (
                  <ProviderEditor
                    p={p}
                    desktop={desktop}
                    onChange={(np) => setProviders(providers.map((x) => (x.id === p.id ? np : x)))}
                    onKey={(k) => props.onProviderKey(p.id, k)}
                    onRemove={() => { setProviders(providers.filter((x) => x.id !== p.id)); setEditing(null); }}
                  />
                )}
              </div>
            ))}
            <button className="secondary" data-testid="prov-add" onClick={() => {
              const np: Provider = { id: uid(), name: "New provider", baseUrl: "", format: "responses", models: [] };
              setProviders([...providers, np]);
              setEditing(np.id);
            }}><Icon name="plus" /> Add provider</button>
          </div>
        )}

        {tab === "appearance" && (
          <div className="stack">
            <div className="seg" role="radiogroup">
              {(["dark", "light", "system"] as const).map((t) => (
                <button key={t} className={(s.theme ?? "dark") === t ? "on" : ""} data-testid={`theme-${t}`} onClick={() => set({ ...s, theme: t })}>
                  <Icon name={t === "light" ? "sun" : t === "dark" ? "moon" : "panelLeft"} /> {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === "agent" && (
          <div className="stack">
            {configOptions.length === 0 && <p className="muted">Session options appear after you start a chat.</p>}
            {configOptions.map((o) => (
              <label key={o.id}>{o.name ?? o.id}
                <select defaultValue={o.currentValue} onChange={(e) => onConfig(o.id, e.target.value)}>
                  {(o.options ?? []).map((v) => <option key={v.value} value={v.value}>{v.name && v.name !== v.value ? `${v.name} (${v.value})` : v.value}</option>)}
                </select>
              </label>
            ))}
            {extensions.length > 0 && (
              <>
                <h4>Agent extensions</h4>
                <div className="mono muted">{extensions.join("\n")}</div>
              </>
            )}
          </div>
        )}

        {tab === "devices" && <div className="stack">{props.devices ?? <p className="muted">Pairing needs the desktop app.</p>}</div>}
        </div>
        {tab !== "devices" && (
          <footer className="screen-foot">
            <button className="secondary" onClick={onClose}>Cancel</button>
            <button onClick={() => onSave(s)} data-testid="settings-save">Save & reconnect</button>
          </footer>
        )}
      </div>
    </div>
  );
}

/** Where the agent binary was found, and the captured agent stdout/stderr. */
function AgentLog() {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const load = () => { void agentInfo().then(setInfo, () => {}); void agentLog().then(setLog, (e) => setLog(String(e))); };
  return (
    <div className="agent-log" data-testid="agent-log">
      <div className="row"><strong>Agent</strong><div className="spacer" /><button className="secondary compact" onClick={load}>{log == null ? "Show agent log" : "Refresh"}</button></div>
      {info && <p className="muted small">CLI: <code>{info.bin ?? "not found"}</code>{info.managed ? " · started by Supercharge Studio" : ""} · log: <code>{info.log}</code></p>}
      {log != null && <pre className="log">{log || "(empty)"}</pre>}
    </div>
  );
}
