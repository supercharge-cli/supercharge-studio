/**
 * Anonymous usage stats. The app keeps only allowlisted event names and properties (never chat
 * text, code, paths or keys) and sends nothing when they are off in Settings or not built in.
 */
export const track = (name: string, props?: object): void => void (globalThis as any).__TAURI_INTERNALS__?.invoke("telemetry_event", { name, props }).catch(() => {});

/** Desktop: report model picks (the id only) from the agent client's requests, whichever screen makes them. */
export function trackModels(c: { request: (method: string, params?: any, opts?: any) => Promise<any> }) {
  const req = c.request.bind(c);
  c.request = (m, p, o) => {
    const model = m == "session/set_model" ? p?.modelId : m == "session/set_config_option" && p?.configId == "model" && p.value;
    if (model) track("model_selected", { model });
    return req(m, p, o);
  };
}
