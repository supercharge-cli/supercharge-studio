import { useEffect, useState } from "react";
import { gateway, GwPairing, GwStatus } from "../lib/desktop";
import { Icon } from "./Icon";
import { defaultGatewayPrefs, GatewayPrefs } from "../lib/store";
export { defaultGatewayPrefs };
export type { GatewayPrefs };
import { BackgroundSetting } from "./Background";
import { DEFAULT_RELAY, effectiveRelay, ensureHostId, newHostId, reachOf, relayConnect, type Reach } from "../lib/reach";

/** Device-facing connect URL on the relay for this computer (see docs/MOBILE-PLAN.md, Relay). */
export const relayConnectUrl = (p: GatewayPrefs) => relayConnect(p);
/** Port in a gateway URL such as ws://192.168.1.5:2421/gw. */
export const urlPort = (u: string) => { try { return Number(new URL(u).port) || 0; } catch { return 0; } };
export const gatewayBind = (p: GatewayPrefs) => `${p.mode === "lan" ? "0.0.0.0" : "127.0.0.1"}:${p.port}`;

export function DevicesSection({ prefs, onPrefs, desktop }: { prefs: GatewayPrefs; onPrefs: (p: GatewayPrefs) => void; desktop: boolean }) {
  const [st, setSt] = useState<GwStatus | null>(null);
  const [pair, setPair] = useState<GwPairing | null>(null);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now());
  const refresh = () => desktop && void gateway.status().then(setSt).catch((e) => setErr(String(e)));
  useEffect(() => {
    refresh();
    const t = setInterval(() => { setNow(Date.now()); refresh(); }, 1000);
    return () => clearInterval(t);
  }, []);
  if (!desktop) return <p className="muted">The mobile gateway runs in the desktop app.</p>;
  const left = pair ? Math.max(0, Math.round((pair.expiresAt - now) / 1000)) : 0;

  async function toggle(on: boolean) {
    setErr("");
    try {
      let port = prefs.port;
      if (on) {
        // The gateway picks another port when the preferred one is taken; keep using that one.
        port = urlPort(await gateway.start(gatewayBind(prefs))) || prefs.port;
        const p = ensureHostId(prefs);
        const r = effectiveRelay(p);
        if (r) await gateway.relaySet(r, p.hostId);
        onPrefs({ ...p, enabled: on, port });
      } else { await gateway.stop(); setPair(null); onPrefs({ ...prefs, enabled: on, port }); }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
    refresh();
  }

  const reach = reachOf(prefs);
  const relay = effectiveRelay(prefs);
  async function setReach(r: Reach) {
    setErr("");
    const p = ensureHostId({ ...prefs, reach: r });
    onPrefs(p);
    setPair(null); // old codes carry the old route
    if (st?.running) await gateway.relaySet(effectiveRelay(p), p.hostId).catch((e) => setErr(String(e)));
    refresh();
  }
  const reachSwitch = (
    <div className="seg reach" role="radiogroup" aria-label="Connection" data-testid="gw-reach" data-reach={reach}>
      <button role="radio" aria-checked={reach === "local"} className={reach === "local" ? "on" : ""} data-testid="gw-reach-local" onClick={() => void setReach("local")}>Local</button>
      <button role="radio" aria-checked={reach === "public"} className={reach === "public" ? "on" : ""} data-testid="gw-reach-public" onClick={() => void setReach("public")}>Public</button>
    </div>
  );
  const reachHelp = reach === "public"
    ? <>Works from any network through <code>{relay}</code>. Phones on the same Wi-Fi still connect directly first. The relay only forwards end-to-end encrypted frames.</>
    : <>Phones must be on the same Wi-Fi as this computer.</>;

  return (
    <div className="stack" data-testid="devices">
      <p className="muted">Pair a phone to follow and steer your sessions. Traffic is end-to-end encrypted with a key that only the paired device and this computer know; it never leaves the QR code.</p>
      <BackgroundSetting />
      <div className="card">
        <div className="row between">
          <div>
            <strong>Mobile gateway</strong>
            <div className="muted">{st?.running ? <>Listening on <code>{st.url}</code></> : "Off"}</div>
          </div>
          <label className="switch"><input type="checkbox" data-testid="gw-toggle" checked={!!st?.running} onChange={(e) => void toggle(e.target.checked)} /><i /></label>
        </div>
        <div className="row between reach-row">
          <div><strong>Connection</strong><div className="muted small" data-testid="gw-reach-help">{reachHelp}</div></div>
          {reachSwitch}
        </div>
        <div className="grid2">
          <label>Reachable from
            <select value={prefs.mode} disabled={!!st?.running} onChange={(e) => onPrefs({ ...prefs, mode: e.target.value as GatewayPrefs["mode"] })}>
              <option value="lan">Local network (Wi-Fi)</option>
              <option value="tunnel">This computer only (use with a tunnel)</option>
            </select>
          </label>
          <label>Port<input type="number" value={prefs.port} disabled={!!st?.running} onChange={(e) => onPrefs({ ...prefs, port: Number(e.target.value) || 2420 })} /></label>
        </div>
        <label>Public URL (optional, for tunnels)
          <input placeholder="wss://my-tunnel.example.com/gw" value={prefs.publicUrl} onChange={(e) => onPrefs({ ...prefs, publicUrl: e.target.value })} />
        </label>
        <label>Custom relay URL (Public mode, optional)
          <input data-testid="gw-relay" placeholder={DEFAULT_RELAY} value={prefs.relayUrl ?? ""} onBlur={() => st?.running && void gateway.relaySet(effectiveRelay(prefs), prefs.hostId).then(refresh).catch((e) => setErr(String(e)))} onChange={(e) => onPrefs({ ...prefs, relayUrl: e.target.value, hostId: prefs.hostId || newHostId() })} />
          <span className="muted small">Leave empty to use the built-in relay. Phones try the direct address first, then the relay.</span>
          {st?.running && /bound to another key/.test(st.relay ?? "") && (
            <span className="small">This computer's relay ID is taken on that relay. <button className="ghost" data-testid="gw-relay-reset" onClick={() => { const hostId = newHostId(); onPrefs({ ...prefs, hostId }); void gateway.relaySet(effectiveRelay(prefs), hostId).then(refresh).catch((e) => setErr(String(e))); }}>Use a new relay ID</button> (then show a new pairing code).</span>
          )}
          {st?.running && relay && <span className={`relay-status ${st.relay === "online" ? "ok" : st.relay?.startsWith("retrying") ? "bad" : ""}`} data-testid="gw-relay-status"><i className="dot" /> Relay: {st.relay ?? "off"}</span>}
        </label>
        {st?.running && prefs.mode === "lan" && (
          <div className="gw-diag" data-testid="gw-diag">
            {st.port_note && <span className="small warn-text" data-testid="gw-port-note">The preferred port was in use, so the gateway is on port <b>{st.port}</b> ({st.port_note}). Paired phones find it automatically; new pairing codes use it.</span>}
            <span className="muted small">Phones try {(st.urls ?? []).length > 1 ? "these addresses in order" : "this address"}{relay ? ", then the relay" : ""}:</span>
            <ul className="mono small">{(st.urls ?? [st.url ?? ""]).map((u) => <li key={u}>{u}</li>)}</ul>
            <span className="muted small">Phone says it can't reach the gateway? Open <code>{(st.urls?.[0] ?? st.url ?? "").replace(/^ws/, "http").replace(/\/gw$/, "/")}</code> in the phone's browser. If that doesn't load, the phone is on another network or the firewall is blocking port {st.port ?? prefs.port}.</span>
            {st.firewall && <FirewallBox fw={st.firewall} port={st.port ?? prefs.port} onDone={refresh} />}
          </div>
        )}
        {err && <div className="error-text">{err}</div>}
      </div>

      <div className="card">
        <div className="row between">
          <strong>Pair a phone</strong>
          {reachSwitch}
          <button data-testid="gw-pair" disabled={!st?.running} onClick={() => void gateway.pairBegin(prefs.publicUrl || undefined, undefined, relayConnectUrl(prefs)).then(setPair).catch((e) => setErr(String(e)))}>
            <Icon name="qr" /> {pair && left > 0 ? "New code" : "Show pairing code"}
          </button>
        </div>
        {pair && left > 0 && st?.firewall && st.firewall.open !== true && prefs.mode === "lan" && (
          <div className="fw-warn" data-testid="gw-pair-firewall"><FirewallBox fw={st.firewall} port={st.port ?? prefs.port} onDone={refresh} prominent /></div>
        )}
        {pair && left > 0 && (
          <div className="pair">
            <div className="qr" dangerouslySetInnerHTML={{ __html: pair.svg }} />
            <div className="stack">
              <p>Scan with Supercharge Studio on your phone, or open/paste the link there. Expires in <b data-testid="gw-countdown">{left}s</b>, single use.</p>
              <p className="muted small" data-testid="gw-pair-route">{reach === "public" ? "Public: works on any network (direct on the same Wi-Fi, otherwise through the relay)." : "Local: the phone must be on the same Wi-Fi."}</p>
              <p className="muted">No camera? Copy the code and paste it in the app.</p>
              <button className="secondary" onClick={() => void navigator.clipboard?.writeText(pair.uri)}>Copy pairing code</button>
              <input readOnly className="mono" data-testid="gw-uri" value={pair.uri} onFocus={(e) => e.target.select()} />
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <strong>Paired devices</strong>
        {(st?.devices ?? []).length === 0 && <p className="muted">No devices yet.</p>}
        {(st?.devices ?? []).map((d) => {
          const on = st?.connected.includes(d.id);
          return (
            <div key={d.id} className="prov-row" data-testid="gw-device">
              <span className={`status ${on ? "ok" : ""}`}><i className="dot" /></span>
              <div className="prov-main"><strong>{d.name}</strong><span className="muted">{on ? "Connected" : `Last seen ${new Date(d.last_seen * 1000).toLocaleString()}`}</span></div>
              <button className="ghost danger-text" onClick={() => void gateway.revoke(d.id).then(refresh)}>Revoke</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Firewall status for the gateway port with a one-click "Allow in firewall" where the OS supports it. */
export function FirewallBox({ fw, port, onDone, prominent }: { fw: NonNullable<GwStatus["firewall"]>; port: number; onDone: () => void; prominent?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const name = fw.kind === "firewalld" ? "firewalld" : fw.kind === "ufw" ? "ufw" : fw.kind === "windows" ? "Windows Firewall" : "the macOS firewall";
  const head = fw.open === true ? `Port ${port}/tcp is open in ${name}.`
    : fw.open === false ? `${name} is blocking port ${port}/tcp, so phones can't connect.`
    : `${name} is active and may block port ${port}/tcp.`;
  async function allow() {
    setBusy(true); setMsg(null);
    try { setMsg({ ok: true, text: await gateway.firewallAllow() }); } catch (e) { setMsg({ ok: false, text: String((e as Error)?.message ?? e) }); }
    setBusy(false); onDone();
  }
  return (
    <div className={`fw-hint${prominent ? " prominent" : ""}${fw.open === true ? " ok" : ""}`} data-testid="gw-firewall" data-open={String(fw.open)}>
      <span className={`small ${fw.open === true ? "" : "warn-text"}`}><b>{head}</b></span>
      {fw.open !== true && (
        <>
          {fw.can_allow && <div className="row"><button data-testid="gw-fw-allow" disabled={busy} onClick={() => void allow()}>{busy ? "Waiting for permission…" : "Allow in firewall"}</button><span className="muted small">{fw.kind === "windows" ? "Windows will ask for administrator approval." : "You'll be asked for your password."}</span></div>}
          {fw.kind === "macos" ? <span className="small">{fw.cmd}</span> : (
            <>
              <span className="muted small">{fw.can_allow ? "Or run it yourself:" : "Run this in a terminal:"}</span>
              <div className="row"><code className="mono small grow">{fw.cmd}</code><button className="ghost" onClick={() => void navigator.clipboard?.writeText(fw.cmd)}>Copy</button></div>
            </>
          )}
          <span className="muted small">The gateway keeps this port ({port}) across restarts, so the rule only needs adding once.</span>
        </>
      )}
      {msg && <span className={`small ${msg.ok ? "ok-text" : "error-text"}`} data-testid="gw-fw-result">{msg.text}</span>}
    </div>
  );
}
