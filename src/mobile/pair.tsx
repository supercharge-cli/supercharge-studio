/** First-run pairing screen (code, QR scan, deep links). Loads only while the phone is unpaired. */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { candidates, GatewayTransport, type DeviceCreds } from "../gateway/transport";
import { parsePairUri } from "../gateway/crypto";
import { defaultDeviceName, pendingCredsFromCode } from "./creds";
import { phoneIp } from "./ip";
import { canScan, onPairLink } from "./scan";
import Scanner from "./scanner";
import { createPortal } from "react-dom";

export default function Pair({ onPaired }: { onPaired: (c: DeviceCreds) => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultDeviceName());
  const [stage, setStage] = useState<"" | "connecting" | "waiting">("");
  const [err, setErr] = useState("");
  useEffect(() => { void onPairLink((c) => { setCode(c); void pair(c); }).catch(() => {}); }, []);
  const [scanOpen, setScanOpen] = useState(false);
  const pairing = useRef(false);
  const codeEl = useRef<HTMLTextAreaElement>(null);
  async function pair(c = code) {
    if (pairing.current) return;
    pairing.current = true;
    setErr("");
    try {
      const creds = await pendingCredsFromCode(c, name);
      setStage("connecting");
      const t = new GatewayTransport(candidates(creds), creds.deviceId, creds.key, name, undefined, (s) => s === "waiting" && setStage("waiting"));
      t.localIp = await phoneIp();
      await t.open();
      t.close();
      // Remember the address that worked so the next launch tries it first.
      const direct = t.route === "direct" && t.connectedUrl ? t.connectedUrl : creds.url;
      const alts = [creds.url, ...(creds.alts ?? [])].filter((u) => u !== direct);
      onPaired({ ...creds, url: direct, alts, deviceId: t.deviceId });
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setStage("");
      setScanOpen(false);
    } finally {
      pairing.current = false;
    }
  }
  return (
    <div className="m-pair" data-testid="m-pair">
      <div className="m-hero"><div className="logo big"><img src="/logo.png" alt="" /></div><h1>Supercharge Studio</h1><p className="muted">Pair with Supercharge Studio on your computer: Settings → Devices → Show pairing code.</p></div>
      {canScan() && <button className="m-big" disabled={!!stage} onClick={() => { setErr(""); setScanOpen(true); }} data-testid="m-scan"><Icon name="qr" /> Scan QR code</button>}
      <label>Device name<input value={name} onChange={(e) => setName(e.target.value)} data-testid="m-name" /></label>
      <label>Pairing code<textarea ref={codeEl} rows={3} value={code} placeholder="scstudio://pair?…" onChange={(e) => setCode(e.target.value)} data-testid="m-code" /></label>
      <button className="m-big" disabled={!code.trim() || !!stage} onClick={() => void pair()} data-testid="m-pair-btn">{stage === "waiting" ? "Confirm on your computer…" : stage === "connecting" ? "Connecting…" : "Pair"}</button>
      {err && <div className="error-text" data-testid="m-error">{err}</div>}
      {/* On <body>: the screen's entry animation would otherwise trap the fixed sheet inside it. */}
      {scanOpen && createPortal(<Scanner waiting={stage === "waiting"} onCode={(c) => { setCode(c); void pair(c); }} onClose={() => setScanOpen(false)} onPaste={() => { setScanOpen(false); codeEl.current?.focus(); }} />, document.body)}
    </div>
  );
}
