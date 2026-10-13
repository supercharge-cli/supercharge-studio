import { useEffect, useState } from "react";
import { gateway, GwPairing, GwStatus } from "../lib/desktop";
import { Icon } from "./Icon";

export type GatewayPrefs = { enabled: boolean; mode: "lan" | "tunnel"; port: number; publicUrl: string; relayUrl?: string; hostId?: string };
/** Device-facing connect URL on the relay for this computer (see docs/MOBILE-PLAN.md, Relay). */
export const relayConnectUrl = (p: GatewayPrefs) => (p.relayUrl?.trim() && p.hostId ? `${p.relayUrl.trim().replace(/\/+$/, "")}/v1/connect/${p.hostId}` : undefined);
export const defaultGatewayPrefs: GatewayPrefs = { enabled: false, mode: "lan", port: 2420, publicUrl: "" };
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
      if (on) { await gateway.start(gatewayBind(prefs)); if (prefs.relayUrl?.trim()) await gateway.relaySet(prefs.relayUrl.trim(), prefs.hostId); }
      else { await gateway.stop(); setPair(null); }
      onPrefs({ ...prefs, enabled: on });
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
    refresh();
  }

  return (
    <div className="stack" data-testid="devices">
      <p className="muted">Pair a phone to follow and steer your sessions. Traffic is end-to-end encrypted with a key that only the paired device and this computer know; it never leaves the QR code.</p>
      <div className="card">
        <div className="row between">
          <div>
            <strong>Mobile gateway</strong>
            <div className="muted">{st?.running ? <>Listening on <code>{st.url}</code></> : "Off"}</div>
          </div>
          <label className="switch"><input type="checkbox" data-testid="gw-toggle" checked={!!st?.running} onChange={(e) => void toggle(e.target.checked)} /><i /></label>
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
        <label>Relay URL (optional)
          <input data-testid="gw-relay" placeholder="wss://relay.example.com" value={prefs.relayUrl ?? ""} onBlur={() => st?.running && void gateway.relaySet(prefs.relayUrl?.trim() || undefined, prefs.hostId).then(refresh).catch((e) => setErr(String(e)))} onChange={(e) => onPrefs({ ...prefs, relayUrl: e.target.value, hostId: prefs.hostId || Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("") })} />
          <span className="muted small">Phones try the direct address first, then this relay. The relay only forwards encrypted frames.</span>
          {st?.running && prefs.relayUrl?.trim() && <span className={`relay-status ${st.relay === "online" ? "ok" : st.relay?.startsWith("retrying") ? "bad" : ""}`} data-testid="gw-relay-status"><i className="dot" /> Relay: {st.relay ?? "off"}</span>}
        </label>
        {st?.running && prefs.mode === "lan" && (
          <div className="gw-diag" data-testid="gw-diag">
            <span className="muted small">Phones try {(st.urls ?? []).length > 1 ? "these addresses in order" : "this address"}{prefs.relayUrl?.trim() ? ", then the relay" : ""}:</span>
            <ul className="mono small">{(st.urls ?? [st.url ?? ""]).map((u) => <li key={u}>{u}</li>)}</ul>
            <span className="muted small">Phone says it can't reach the gateway? Open <code>{(st.urls?.[0] ?? st.url ?? "").replace(/^ws/, "http").replace(/\/gw$/, "/")}</code> in the phone's browser. If that doesn't load, the phone is on another network or the firewall is blocking port {prefs.port}.</span>
            {st.firewall && (
              <div className="fw-hint" data-testid="gw-firewall">
                <span className="small">A firewall is active on this computer. Allow the gateway port with:</span>
                <div className="row"><code className="mono small grow">{st.firewall}</code><button className="ghost" onClick={() => void navigator.clipboard?.writeText(st.firewall!.split("  (")[0])}>Copy</button></div>
              </div>
            )}
          </div>
        )}
        {err && <div className="error-text">{err}</div>}
      </div>

      <div className="card">
        <div className="row between">
          <strong>Pair a phone</strong>
          <button data-testid="gw-pair" disabled={!st?.running} onClick={() => void gateway.pairBegin(prefs.publicUrl || undefined, undefined, relayConnectUrl(prefs)).then(setPair).catch((e) => setErr(String(e)))}>
            <Icon name="qr" /> {pair && left > 0 ? "New code" : "Show pairing code"}
          </button>
        </div>
        {pair && left > 0 && (
          <div className="pair">
            <div className="qr" dangerouslySetInnerHTML={{ __html: pair.svg }} />
            <div className="stack">
              <p>Scan with Supercharge Studio on your phone, or open/paste the link there. Expires in <b data-testid="gw-countdown">{left}s</b>, single use.</p>
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
