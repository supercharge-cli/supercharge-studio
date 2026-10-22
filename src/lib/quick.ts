/** Phone quick actions: answering an approval from its notification. */
type Opt = { optionId: string; kind: string };

/** The option a notification's Allow / Deny button stands for (one-time choices first). */
export const answerOption = (options: Opt[], allow: boolean) =>
  (allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"]).map((k) => options.find((o) => o.kind === k)).find(Boolean)?.optionId;

/** Notification key for a permission request. */
export const permKey = (r: { sessionId: string; toolCall: { toolCallId: string } }) => `${r.sessionId}:${r.toolCall.toolCallId}`;
