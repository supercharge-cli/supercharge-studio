/** Saved prompts: each one is also a custom slash command (`/name args`). */
export type Prompt = { name: string; text: string };

/** Command names: lowercase letters, digits and dashes. */
export const promptName = (s: string) => s.trim().toLowerCase().replace(/^\/+/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "");

/** `/name args` → the saved text, with `$ARGUMENTS` replaced (or args appended); null when no prompt matches. */
export function expandPrompt(prompts: Prompt[] | undefined, text: string): string | null {
  const m = text.trim().match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
  const p = m && prompts?.find((x) => x.name === m[1].toLowerCase());
  if (!p) return null;
  const args = (m![2] ?? "").trim();
  return p.text.includes("$ARGUMENTS") ? p.text.split("$ARGUMENTS").join(args) : args ? `${p.text}\n\n${args}` : p.text;
}
