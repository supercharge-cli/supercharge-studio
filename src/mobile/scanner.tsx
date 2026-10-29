/** Full-screen pairing QR scanner: live camera behind a framed window, then a connecting state. Part of the lazy pairing chunk. */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { parsePairUri } from "../gateway/crypto";
import { buzz, cameraReady, openCameraSettings, scanOnce, stopScan } from "./scan";

export type ScanState = "start" | "scan" | "ok" | "link" | "denied" | "nocam" | "bad" | "err";

const PASTE = "or paste the pairing link instead.";
const COPY: Record<ScanState, string[]> = {
  start: ["Starting the camera…"],
  scan: ["Hold steady and fill the square"],
  ok: ["Code found"],
  link: ["Connecting to $…", "Linking devices", "Keep the app open for a moment."],
  denied: ["Camera access is off", "Allow the camera", "Turn on camera access for Supercharge Studio in Settings, " + PASTE],
  nocam: ["No camera found", "No camera on this device", "Paste the pairing link from your computer instead."],
  bad: ["Not a pairing code", "That's a different QR code", "Scan the code under Settings → Devices in Supercharge Studio."],
  err: ["The camera didn't start", "Couldn't scan", "Try again, " + PASTE],
};
const WAIT = ["Approve this phone on $", "Almost there", "Confirm the request in Supercharge Studio on $."];

/** What the sheet says in each state: [subtitle, panel title, panel text]. */
export const scanCopy = (s: ScanState, pc = "your computer", waiting = false): string[] =>
  (s === "link" && waiting ? WAIT : COPY[s]).map((t) => t.replace("$", pc));

const cam = (on: boolean) => document.documentElement.classList.toggle("m-cam", on);
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function Scanner({ waiting, onCode, onClose, onPaste }: { waiting: boolean; onCode: (c: string) => void; onClose: () => void; onPaste: () => void }) {
  const [st, setSt] = useState<ScanState>("start");
  const [pc, setPc] = useState<string>();
  const alive = useRef(true);
  async function run() {
    setSt("start");
    const r = await cameraReady();
    if (!alive.current) return;
    if (r !== "ok") return setSt(r);
    cam(true);
    setSt("scan");
    let c: string | null;
    try { c = await scanOnce(); } catch { c = ""; }
    cam(false);
    if (!alive.current) return;
    if (c === null) return onClose();
    if (!c) return setSt("err");
    try { setPc(parsePairUri(c).desktopName || undefined); } catch { return setSt("bad"); }
    buzz();
    setSt("ok");
    await new Promise((res) => setTimeout(res, calm() ? 0 : 560));
    if (!alive.current) return;
    setSt("link");
    onCode(c);
  }
  useEffect(() => {
    alive.current = true;
    void run();
    return () => { alive.current = false; cam(false); void stopScan(); };
  }, []);
  const [sub, title, text] = scanCopy(st, pc, waiting);
  const live = st === "start" || st === "scan" || st === "ok";
  const fix = st === "denied" || st === "nocam" || st === "err";
  return (
    <div className={`m-scan s-${st}`} role="dialog" aria-modal="true" aria-label="Scan pairing QR" data-testid="m-scanner">
      <div className="m-scan-head">
        <div><h2>{st === "link" ? "Pairing" : "Scan pairing QR"}</h2><p aria-live="polite" data-testid="m-scan-sub">{sub}</p></div>
        <button className="icon" aria-label="Close scanner" onClick={onClose} data-testid="m-scan-close"><Icon name="x" size={22} /></button>
      </div>
      <div className="m-scan-win">
        <div className="m-scan-frame"><i /><i /><i /><i /></div>
        {st === "scan" && <div className="m-scan-line" />}
        {st === "ok" && <span className="m-scan-ok"><Icon name="check" size={34} /></span>}
        {!live && (
          <div className="m-scan-panel">
            {st === "link" ? <Link on /> : <span className="m-scan-ico"><Icon name={fix ? (st === "nocam" ? "phone" : "alert") : "qr"} size={26} /></span>}
            <b>{title}</b><p>{text}</p>
          </div>
        )}
      </div>
      {live && <div className="m-scan-hint"><Link /><span>Point at the code on your computer<small>Settings → Devices → Show pairing code</small></span></div>}
      <div className="m-scan-acts">
        {st === "denied" && <button className="m-big" onClick={() => void openCameraSettings()} data-testid="m-scan-settings">Open Settings</button>}
        {(st === "bad" || st === "err") && <button className="m-big" onClick={() => void run()} data-testid="m-scan-retry">Scan again</button>}
        {(fix || st === "bad") && <button className="m-big secondary" onClick={onPaste} data-testid="m-scan-paste">Paste link instead</button>}
        <button className="ghost" onClick={onClose} data-testid="m-scan-cancel">Cancel</button>
      </div>
    </div>
  );
}

/** Phone ⋯ computer motif; the dots flow while devices link up. */
function Link({ on }: { on?: boolean }) {
  return <span className={`m-link${on ? " on" : ""}`} aria-hidden="true"><Icon name="phone" size={on ? 26 : 18} /><i /><i /><i /><Icon name="laptop" size={on ? 30 : 20} /></span>;
}
