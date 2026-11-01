import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Account, CatalogPlugin, Plugin, PluginRpc } from "../lib/plugins";

type Props = { rpc?: PluginRpc; target: string; connections?: boolean };
export function Plugins({ rpc, target, connections = false }: Props) {
  const [plugins, setPlugins] = useState<Plugin[]>([]), [catalog, setCatalog] = useState<CatalogPlugin[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]), [servers, setServers] = useState<any[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [catalogURL, setCatalogURL] = useState(""), [catalogToken, setCatalogToken] = useState("");
  const [catalogStatus, setCatalogStatus] = useState<{ hasToken?: boolean; environmentOverride?: boolean }>({});
  const [details, setDetails] = useState<any>(null);
  const [source, setSource] = useState(""), [review, setReview] = useState<CatalogPlugin | null>(null);
  const [plugin, setPlugin] = useState("github"), [server, setServer] = useState("supercharge-github"), [account, setAccount] = useState("default");
  const [kind, setKind] = useState("bearer"), [secret, setSecret] = useState(""), [clientId, setClientId] = useState("");
  const [scopes, setScopes] = useState("");
  const [flow, setFlow] = useState(""), [consent, setConsent] = useState("");
  const generation = useRef(0);
  const refresh = async () => {
    if (!rpc) return;
    const generationAtStart = generation.current;
    const [p, c, a, s, cfg] = await Promise.all([rpc("plugins/list"), rpc("plugins/catalog").catch((e) => ({ plugins: [], error: e.message })), rpc("connections/list"), rpc("mcp/list"), rpc("plugins/catalog_config")]);
    if (generation.current !== generationAtStart) return;
    setPlugins(p.plugins ?? []); setCatalog(c.plugins ?? []); setAccounts(a.accounts ?? []); setServers(s.servers ?? []); setCatalogURL(cfg.url ?? "https://www.superchargeai.in/api/plugins/v1"); setCatalogStatus(cfg); if (c.error) setError(c.error);
  };
  useLayoutEffect(() => {
    generation.current++; setPlugins([]); setAccounts([]); setServers([]); setSecret(""); setCatalogToken(""); setConsent(""); setFlow(""); setError(""); setDetails(null);
    void refresh().catch((e) => setError(String(e.message ?? e)));
    return () => { generation.current++; };
  }, [rpc, target]);
  useEffect(() => {
    if (!flow || !rpc) return;
    let stopped = false;
    const check = async () => {
      try {
        const r = await rpc("connections/status", { server: flow });
        if (stopped) return;
        const u = r.authorizationUrl ? new URL(r.authorizationUrl) : null;
        setConsent(u?.protocol === "https:" ? u.href : "");
        if (r.status !== "pending") { setFlow(""); setConsent(""); setNotice(r.status === "authenticated" ? "Account connected." : "Connection did not complete. Check OAuth app settings and retry."); await refresh(); }
      } catch (e: any) { if (!stopped) { setError(e.message); setFlow(""); } }
    };
    void check(); const timer = setInterval(() => void check(), 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [flow, rpc]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); } catch (e: any) { setError(e.message ?? String(e)); } finally { setBusy(false); }
  };
  const action = async (action: Record<string, unknown>) => {
    const r = await rpc!("plugins/action", { action });
    setNotice(r.message ?? "Saved.");
    if (r.requiresReload) await rpc!("plugins/action", { action: { type: "reload" } });
  };
  if (!rpc) return <p className="muted">Connect to an updated Supercharge agent and select a project to manage plugins.</p>;
  return <section aria-label={connections ? "Plugin connections" : "Plugins"}>
    <p className="muted small">Target: <strong>{target}</strong>. Changes and credentials stay on this agent.</p>
    {error && <p role="alert" className="error-text">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <button className="secondary compact" disabled={busy} onClick={() => void run(refresh)}>Refresh</button>
    {!connections && <>
      <h3>Plugin catalog API</h3><label>Catalog URL<input placeholder="https://www.superchargeai.in/api/plugins/v1" value={catalogURL} disabled={catalogStatus.environmentOverride} onChange={(e) => setCatalogURL(e.target.value)} /></label><label>Private catalog read token<input type="password" autoComplete="off" placeholder={catalogStatus.hasToken ? "Saved on agent · leave blank to keep" : "Optional for public plugins"} value={catalogToken} disabled={catalogStatus.environmentOverride} onChange={(e) => setCatalogToken(e.target.value)} /></label><p className="muted small">{catalogStatus.environmentOverride ? "Configured by the agent environment. Change that override on the agent host." : "The endpoint and read token are saved on the selected agent. Use a catalog read token, not your website administrator key."}</p><div className="row"><button disabled={busy || !catalogURL || catalogStatus.environmentOverride} className="secondary" onClick={() => void run(async () => { const token = catalogToken; setCatalogToken(""); await rpc!("plugins/catalog_configure", { url: catalogURL, token: token || undefined }); setNotice("Catalog settings saved on this agent."); })}>Connect catalog</button><button disabled={busy || catalogStatus.environmentOverride} className="secondary" onClick={() => void run(async () => { await rpc!("plugins/catalog_configure", { clear: true }); })}>Use built-in catalog</button></div>
      <h3>Available plugins</h3>
      {catalog.map((p) => <div className="card" key={p.name}><strong>{p.name} · {p.version}</strong><p>{p.description}</p><p className="muted small">{p.endpoint} · {p.authentication === "none" ? "No account required" : "Connect your account after installation"}</p><button disabled={busy} className="secondary" onClick={() => setReview(p)}>Review installation</button></div>)}
      {review && <div className="card" role="region" aria-label="Review plugin installation"><h3>Install {review.name}</h3><p>This package adds workflow instructions and tools from {review.endpoint}. Installation does not sign you in.</p><p>Review the endpoint and enable only tools you trust.</p><button disabled={busy} onClick={() => void run(async () => { const installed = plugins.find((p) => p.name === review.name); await action(installed ? { type: "update", plugin_id: installed.id } : { type: "install", source: review.source }); setReview(null); })}>Install package</button> <button className="secondary" onClick={() => setReview(null)}>Cancel</button></div>}
      {details && <div className="card" role="region" aria-label="Review plugin activation"><h3>Enable {details.plugin.name}</h3><p>Skills: {(details.plugin.skillNames ?? []).join(", ") || "None"}. Hooks: {details.hooks}.</p>{details.servers.map((s: any) => <p key={s.name}>{s.name}: {s.endpoint ?? `${s.command} ${(s.arguments ?? []).join(" ")}`} · {s.permission}</p>)}<p>Enabled plugins can run these tools and hooks under the agent's permission policy.</p><button disabled={busy} onClick={() => void run(async () => { await action({ type: "enable", plugin_id: details.plugin.id }); setDetails(null); })}>Enable reviewed plugin</button> <button className="secondary" onClick={() => setDetails(null)}>Cancel</button></div>}
      <h3>Install from source</h3><label>Git URL or path on this agent<input value={source} onChange={(e) => setSource(e.target.value)} /></label><p className="muted small">Only install packages you have reviewed. Plugins may contain executable tools and hooks.</p><button disabled={busy || !source.trim()} onClick={() => void run(async () => { await action({ type: "install", source: source.trim() }); setSource(""); })}>Install reviewed source</button>
      <h3>Installed plugins</h3>
      {!plugins.length && <p className="muted">No plugins found on this agent.</p>}
      {plugins.map((p) => <div className="card" key={p.id}><strong>{p.name} {p.version}</strong><p>{p.description}</p><p className="muted small">{p.enabled ? "Enabled" : "Disabled"} · {p.trusted ? "Trusted" : "Awaiting trust"} · {p.mcpServerCount} tool servers · {(p.skillNames ?? []).join(", ")}</p><div className="row"><button disabled={busy} className="secondary" onClick={() => void run(async () => { if (p.enabled) await action({ type: "disable", plugin_id: p.id }); else setDetails(await rpc!("plugins/details", { id: p.id })); })}>{p.enabled ? "Disable" : "Enable"}</button><button disabled={busy} className="secondary" onClick={() => void run(() => action({ type: "update", plugin_id: p.id }))}>Update</button><button disabled={busy} className="secondary" onClick={() => void run(() => action({ type: "uninstall", plugin_id: p.id, confirmed: false }))}>Uninstall</button></div></div>)}
    </>}
    {connections && <>
      <h3>Configure an account</h3>
      <div className="row"><label>Plugin<input value={plugin} onChange={(e) => setPlugin(e.target.value)} /></label><label>Server in package<input value={server} onChange={(e) => setServer(e.target.value)} /></label><label>Account name<input value={account} onChange={(e) => setAccount(e.target.value)} /></label></div>
      <label>Authentication<select value={kind} onChange={(e) => { setKind(e.target.value); setSecret(""); }}><option value="bearer">Access token / API key</option><option value="oauth">OAuth application</option></select></label>
      {kind === "bearer" ? <label>Access token<input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></label> : <><label>OAuth client ID<input value={clientId} onChange={(e) => setClientId(e.target.value)} /></label><label>OAuth client secret (optional)<input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></label><label>OAuth scopes (space separated, optional)<input value={scopes} onChange={(e) => setScopes(e.target.value)} /></label></>}
      <p className="muted small">Use your own OAuth app registration. Client secrets are sent directly to the selected agent. File storage is used when no keychain is available.</p>
      <button disabled={busy || !plugin || !server || !account || (kind === "bearer" ? !secret : !clientId)} onClick={() => void run(async () => { const value = secret; setSecret(""); await rpc("connections/configure", { plugin, server, account, secretKind: kind === "bearer" ? "bearer" : value ? "client_secret" : "oauth", secret: value || undefined, clientId: kind === "oauth" ? clientId.trim() : undefined, scopes: kind === "oauth" && scopes.trim() ? scopes.trim().split(/\s+/) : undefined }); setNotice("Account saved on agent."); })}>Save and select account</button>
      <h3>Saved accounts</h3>
      {accounts.map((a) => <div className="card" key={a.id}><strong>{a.plugin} · {a.account}</strong><p className="muted small">{a.origin} · {a.active ? "Selected" : "Available"} · {a.secretBackend ?? "OAuth credential store"}</p><div className="row"><button disabled={busy || a.active} className="secondary" onClick={() => void run(async () => { await rpc("connections/select", { id: a.id }); })}>Select</button><button disabled={busy} className="secondary" onClick={() => void run(async () => { const r = await rpc("connections/disconnect", { id: a.id }); setNotice(`Disconnected. ${r.providerRevocation ?? ""}`); })}>Disconnect</button></div></div>)}
      <h3>Tool server health</h3>
      {servers.filter((s) => s.source === "local").map((s) => <div className="card" key={s.name}><strong>{s.displayName ?? s.name}</strong><p className="muted small">{s.session?.status ?? "Not attached"} · {s.session?.tools?.length ?? 0} {(s.session?.tools?.length ?? 0) === 1 ? "tool" : "tools"}{s.session?.authRequired ? " · Sign-in required" : ""}</p><div className="row"><button disabled={busy} className="secondary" onClick={() => void run(async () => { const r = await rpc("mcp/list", { cache: false }); setServers(r.servers ?? []); })}>Refresh health</button>{s.session?.authRequired && <button disabled={busy || !!flow} className="secondary" onClick={() => void run(async () => { await rpc("connections/connect", { server: s.name }); setFlow(s.name); })}>Connect / reconnect</button>}</div></div>)}
      {flow && <div role="status"><p>Waiting for sign-in…</p>{consent && <a href={consent} target="_blank" rel="noopener noreferrer">Open secure sign-in</a>} <button className="secondary" onClick={() => void run(async () => { await rpc("connections/cancel", { server: flow }); setFlow(""); setConsent(""); })}>Cancel sign-in</button></div>}
    </>}
  </section>;
}
