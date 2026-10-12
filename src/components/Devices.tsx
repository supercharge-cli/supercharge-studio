import { useEffect, useState } from "react";
import { gateway, GwPairing, GwStatus } from "../lib/desktop";
import { Icon } from "./Icon";

export type GatewayPrefs = { enabled: boolean; mode: "lan" | "tunnel"; port: number; publicUrl: string };
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
      if (on) await gateway.start(gatewayBind(prefs));
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
        {err && <div className="error-text">{err}</div>}
      </div>

      <div className="card">
        <div className="row between">
          <strong>Pair a phone</strong>
          <button data-testid="gw-pair" disabled={!st?.running} onClick={() => void gateway.pairBegin(prefs.publicUrl || undefined).then(setPair).catch((e) => setErr(String(e)))}>
            <Icon name="qr" /> {pair && left > 0 ? "New code" : "Show pairing code"}
          </button>
        </div>
        {pair && left > 0 && (
          <div className="pair">
            <div className="qr" dangerouslySetInnerHTML={{ __html: pair.svg }} />
            <div className="stack">
              <p>Scan with Supercharge Studio on your phone. Expires in <b data-testid="gw-countdown">{left}s</b>, single use.</p>
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
