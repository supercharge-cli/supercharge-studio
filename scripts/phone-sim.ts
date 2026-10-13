/**
 * Simulated phone: pairs with a running gateway (desktop app or headless server) the way the
 * mobile app does, using the same candidate order, failover and diagnostics.
 *   npx vite-node scripts/phone-sim.ts -- "<pairing code>" [--dead-first]
 * --relay-only simulates a phone on another network (only the relay works).
 * --dead-first prepends an unreachable address to prove failover to the next one.
 */
import { WebSocket } from "ws";
import { pendingCredsFromCode } from "../src/mobile/creds";
import { candidates, GatewayTransport } from "../src/gateway/transport";

const args = process.argv.slice(2).filter((a) => a !== "--");
const code = args.find((a) => a.includes("pair?"))!;
const creds = await pendingCredsFromCode(code, "Simulated phone");
let urls = candidates(creds);
if (args.includes("--dead-first")) urls = ["ws://10.255.255.1:2420/gw", ...urls];
// --relay-only: every direct address is replaced by an unreachable one (phone on another network).
if (args.includes("--relay-only")) urls = ["ws://10.255.255.1:2420/gw", ...urls.filter((u) => /\/v1\/connect\//.test(u))];
console.log("candidates:", urls.join("  "));
const t = new GatewayTransport(urls, creds.deviceId, creds.key, creds.name, WebSocket as any, (s) => console.log("stage:", s), 1500);
try {
  await t.open();
} catch (e: any) {
  console.log("FAILED\n" + e.message);
  process.exit(1);
}
console.log(`paired: device ${t.deviceId} via ${t.route} ${t.connectedUrl}`);
for (const a of t.attempts) console.log(`  skipped ${a.url}: ${a.reason}`);
const reply = new Promise<string>((r) => { t.onMessage = (d) => r(d); });
t.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }));
console.log("encrypted reply:", (await Promise.race([reply, new Promise<string>((r) => setTimeout(() => r("(none in 10s)"), 10000))])).slice(0, 200));
t.close();
process.exit(0);
