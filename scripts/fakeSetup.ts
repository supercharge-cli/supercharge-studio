/** Scripted provider setup for the fakes: models, save and a two-poll device-code login. */
export function fakeSetup(preset?: Record<string, unknown>) {
  const saved: any = { providerId: null, baseUrl: null, format: null, model: null, hasKey: false, nousSignedIn: false, ...preset };
  let polls = 0;
  const saves: any[] = [];
  const run = async (op: string, p: any = {}): Promise<any> => {
    switch (op) {
      case "status": return { ...saved };
      case "models":
        if (p.providerId === "nous" && !saved.nousSignedIn) throw new Error("Nous Portal is not signed in. Sign in with Nous Research first.");
        if (p.apiKey === "bad") throw new Error("provider returned HTTP 401: invalid API key");
        return [{ id: "model-a", name: "Model A", context: 200000 }, { id: "model-b", name: "Model B" }, { id: "vendor/model-c", name: "vendor/model-c" }];
      case "save":
        saves.push({ ...p, apiKey: p.apiKey === undefined ? "(kept)" : p.apiKey ? "(set)" : "(none)" });
        Object.assign(saved, { providerId: p.providerId, baseUrl: p.baseUrl, format: p.format, model: p.modelId, hasKey: saved.hasKey && p.apiKey === undefined ? true : !!p.apiKey || p.providerId === "nous" });
        return { ...saved };
      case "device_start": polls = 0; return { userCode: "WDJB-MJHT", verificationUri: "https://portal.nousresearch.com/oauth/device?user_code=WDJB-MJHT", expiresIn: 900, interval: 1 };
      case "device_poll": if (++polls < 2) return "pending"; saved.nousSignedIn = true; return "done";
      case "device_cancel": return {};
    }
    throw new Error("Unknown setup step");
  };
  return { run, saves };
}
