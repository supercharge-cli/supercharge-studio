import { lazy, ReactNode, Suspense, useState } from "react";
import { pickSetup, type SetupStatus } from "../lib/setup";
import type { ApiFormat, Provider, Settings as S } from "../lib/store";
import { parseAgentUrl, uid } from "../lib/store";
import type { ConfigOption } from "../acp/types";
import { Icon } from "./Icon";
import { themeList } from "../lib/themes";
const ProviderSetup = lazy(() => import("./ProviderSetup"));
import { agentInfo, agentLog, providerDiscoverModels, type AgentInfo, type DiscoveredModel } from "../lib/desktop";

type Props = {
  value: S;
  configOptions: ConfigOption[];
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
  /** Agent connection: its `_supercharge/setup/*` methods win over the desktop shell's. */
  acp?: { hasExtension(m: string): boolean; ext<T = any>(m: string, p?: unknown): Promise<T> } | null;
  openUrl?: (url: string) => void;
  onSetupSaved?: (s: SetupStatus) => void;
  /** The open chat's agent session, switched to the saved model right away when the agent can. */
  sessionId?: () => string | undefined;
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
  const [discovered, setDiscovered] = useState<DiscoveredModel[] | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const discover = async () => {
    setLoading(true);
    setError("");
    try {
      setDiscovered(await providerDiscoverModels(p.id, p.baseUrl.trim()));
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };
  const available: DiscoveredModel[] = [...(discovered ?? []), ...p.models.filter((id) => !discovered?.some((m) => m.id === id)).map((id) => ({ id }))];
  const shown = available.filter((m) => `${m.name ?? ""} ${m.id}`.toLowerCase().includes(search.toLowerCase()));
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
      <div className="provider-models">
        <div className="row between"><strong>Available models</strong><button className="secondary" data-testid="prov-discover" disabled={!desktop || !p.baseUrl.trim() || loading} onClick={() => void discover()}>{loading ? "Finding models…" : "Refresh models"}</button></div>
        <p className="muted">Choose the models you want available in chats. The desktop app checks /models with and without your saved key.</p>
        {!desktop && <p className="muted">Model discovery requires the desktop app.</p>}
        {error && <p className="danger-text" role="alert">{error}</p>}
        {discovered?.length === 0 && <p className="muted" role="status">The provider returned no models. Your saved selection is unchanged.</p>}
        {available.length > 0 && <input data-testid="prov-model-search" aria-label="Search available models" placeholder="Search models…" value={search} onChange={(e) => setSearch(e.target.value)} />}
        <div className="provider-model-list" data-testid="prov-model-list">
          {shown.map((m) => <label key={m.id} className="check provider-model-row"><input type="checkbox" data-testid="prov-model-choice" checked={p.models.includes(m.id)} onChange={(e) => onChange({ ...p, models: e.target.checked ? [...p.models, m.id] : p.models.filter((id) => id !== m.id) })} />
            <span><strong>{m.name ?? m.id}</strong>{m.name && m.name !== m.id && <small>{m.id}</small>}{m.context && <small>Context: {m.context.toLocaleString()} tokens</small>}{m.reasoning === true && <small>Reasoning supported</small>}</span>
          </label>)}
          {!shown.length && <span className="muted">{discovered ? (discovered.length ? "No matching models" : "The provider returned no models.") : "Refresh to discover available models."}</span>}
        </div>
        <p className="muted">{p.models.length} selected{discovered && p.models.some((id) => !discovered.some((m) => m.id === id)) ? " · Some saved models were not returned; they remain selected until you remove them." : ""}</p>
      </div>
      <label>API key
        <div className="row">
          <input data-testid="prov-key" type="password" placeholder={desktop ? "Stored securely; leave blank to keep" : "Desktop app required"} value={key} disabled={!desktop} onChange={(e) => setKey(e.target.value)} />
          <button className="secondary" disabled={!desktop || !key} onClick={async () => { try { setKeyState(`Saved (${await onKey(key)})`); setKey(""); } catch (e: any) { setKeyState(`Could not save key: ${e?.message ?? e}`); } }}>Save key</button>
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
  const { value, configOptions, desktop, onSave, onConfig, onClose } = props;
  const [s, set] = useState<S>({ ...value, providers: value.providers ?? [] });
  const [tab, setTab] = useState<Section>(props.initial ?? "connection");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [providerError, setProviderError] = useState("");
  const [setup] = useState(() => pickSetup(props.acp));
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
            <label className="check"><input type="checkbox" checked={s.alwaysApprove} onChange={(e) => set({ ...s, alwaysApprove: e.target.checked })} /> Always approve by default for new chats</label>
            <p className="muted small">Change tool permissions for an existing chat with the mode button below its message box.</p>
            <label className="check"><input type="checkbox" data-testid="steer-default" checked={!!s.steerByDefault} onChange={(e) => set({ ...s, steerByDefault: e.target.checked })} /> Messages sent while the agent works steer the current turn (otherwise they wait in a queue)</label>
            <h4 className="set-sub">Notifications</h4>
            <p className="muted small">Shown only when Supercharge isn't focused or you're looking at another chat.</p>
            {([["done", "When a reply finishes"], ["error", "When a turn fails"], ["permission", "When the agent needs approval (permissions, plans)"], ["sound", "Play a sound"]] as const).map(([k, label]) => (
              <label key={k} className="check"><input type="checkbox" data-testid={`notify-${k}`} checked={s.notify?.[k] ?? true} onChange={(e) => set({ ...s, notify: { done: true, error: true, permission: true, sound: true, ...s.notify, [k]: e.target.checked } })} /> {label}</label>
            ))}
            <p className="muted">{desktop ? "The server key is stored in the OS keychain." : "Web mode: settings are stored in this browser."}</p>
            {desktop && <AgentLog />}
          </div>
        )}

        {tab === "providers" && (
          <div className="stack">
            {setup ? (
              <div className="card" data-testid="setup-card"><Suspense fallback={<p className="muted">Loading…</p>}><ProviderSetup api={setup} sessionId={props.sessionId} open={props.openUrl ?? ((u) => window.open(u, "_blank"))} onSaved={(st) => { set({ ...s, activeProviderId: undefined }); props.onSetupSaved?.(st); }} /></Suspense></div>
            ) : <p className="muted">Provider setup needs the desktop app.</p>}
            <h4 className="set-sub">Studio providers</h4>
            <p className="muted">Providers are written to the Supercharge agent config; the active one becomes the default model. Keys stay in secure storage.</p>
            {providerError && <p className="danger-text" role="alert">{providerError}</p>}
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
                    <button className="secondary" data-testid="prov-use" disabled={!!busy || !p.models.length} onClick={async () => {
                      setBusy(p.id);
                      try {
                        await props.onActivate(p, providers);
                        set({ ...s, activeProviderId: p.id });
                      } catch (e: any) {
                        setProviderError(String(e?.message ?? e));
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
            <div className="theme-grid" role="radiogroup" aria-label="Theme">
              {themeList.map((t) => (
                <button key={t.id} role="radio" aria-checked={(s.theme ?? "dark") === t.id} className={`theme-card ${(s.theme ?? "dark") === t.id ? "on" : ""}`} data-testid={`theme-${t.id}`} onClick={() => set({ ...s, theme: t.id })}>
                  <span className="sw">{t.swatch.map((c, i) => <i key={i} style={{ background: c }} />)}</span>
                  <span className="row"><Icon name={t.id === "system" ? "panelLeft" : t.dark ? "moon" : "sun"} size={14} /> {t.name}</span>
                </button>
              ))}
            </div>
            <p className="muted small">The theme preview applies when you save. Animations follow your system's reduced-motion setting.</p>
          </div>
        )}

        {tab === "agent" && (
          <div className="stack">
            {configOptions.length === 0 && <p className="muted">Session options appear after you start a chat.</p>}
            {configOptions.map((o) => (
              <label key={o.id}>{o.name ?? o.id}
                <select defaultValue={o.currentValue} onChange={(e) => onConfig(o.id, e.target.value)}>
                  {(o.options ?? []).map((v) => <option key={v.value} value={v.value}>{v.name || v.value}</option>)}
                </select>
              </label>
            ))}
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
