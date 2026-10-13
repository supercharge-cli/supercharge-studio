/**
 * Sending while the agent is working: queue (default) or steer.
 *
 * Steering uses the agent's native `_supercharge/session/steer` when it advertises
 * `agentCapabilities._meta.supercharge.steer` (non-interrupting: the text is injected at the next
 * safe point of the running turn). Otherwise it falls back to cancel-and-resend: the running turn
 * is cancelled and its prompt is sent again with the steering text appended.
 */
import type { AcpClient } from "./client";

export type Queued = { id: string; text: string };

export interface Steerer {
  /** "native" injects into the running turn; "resend" cancels and re-sends (see `fallback`). */
  readonly mode: "native" | "resend";
  steer(sessionId: string, text: string, extra?: unknown[]): Promise<void>;
}

export const STEER_METHOD = "_supercharge/session/steer";

export function hasNativeSteer(c: Pick<AcpClient, "initResult">): boolean {
  const m = (c.initResult?.agentCapabilities as any)?._meta?.supercharge;
  return m?.steer === true;
}

/** Native steer through the agent. */
export function nativeSteerer(c: Pick<AcpClient, "request">): Steerer {
  return {
    mode: "native",
    async steer(sessionId, text, extra = []) {
      await c.request(STEER_METHOD, { sessionId, prompt: [{ type: "text", text }, ...extra] });
    },
  };
}

/** Cancel the running turn, then let `resend` run the combined prompt once it has stopped. */
export function resendSteerer(cancel: (sid: string) => void, resend: (sid: string, text: string, extra: unknown[]) => void): Steerer {
  return {
    mode: "resend",
    async steer(sessionId, text, extra = []) {
      cancel(sessionId);
      resend(sessionId, text, extra);
    },
  };
}

/** Prompt to re-send after a cancel-and-resend steer. */
export const combineSteer = (original: string, steer: string) => (original.trim() ? `${original.trim()}\n\n${steer.trim()}` : steer.trim());

export function makeSteerer(c: AcpClient, cancel: (sid: string) => void, resend: (sid: string, text: string, extra: unknown[]) => void): Steerer {
  return hasNativeSteer(c) ? nativeSteerer(c) : resendSteerer(cancel, resend);
}
