/** Stateful ACP fixture for desktop plugin lifecycle tests. Never talks to providers. */
export const PLUGIN_METHODS = ["plugins/catalog", "plugins/catalog_config", "plugins/catalog_configure", "plugins/details", "plugins/list", "plugins/action", "connections/list", "connections/configure", "connections/select", "connections/disconnect", "connections/connect", "connections/status", "connections/cancel"].map((m) => `_supercharge/${m}`);
export function fakePlugins() {
  let plugins: any[] = [], accounts: any[] = [];
  let catalogConfig = { url: null as string | null, hasToken: false };
  return (method: string, p: any): any | undefined => {
    const ok = (result: any) => ({ result });
    switch (method) {
      case "_supercharge/plugins/catalog_config": return ok(catalogConfig);
      case "_supercharge/plugins/catalog_configure": catalogConfig = p.clear ? { url: null, hasToken: false } : { url: p.url, hasToken: !!p.token }; return ok(catalogConfig);
      case "_supercharge/plugins/catalog": if (catalogConfig.url !== "https://www.superchargeai.in/api/plugins/v1") return { error: "Catalog URL not configured" }; return ok({ plugins: [{ name: "github", version: "1.0.0", source: "starter:github", endpoint: "https://api.githubcopilot.com/mcp/", authentication: "oauth_or_bearer", description: "GitHub repository tools and release briefs" }, { name: "microsoft-learn", version: "1.0.0", source: "starter:microsoft-learn", endpoint: "https://learn.microsoft.com/api/mcp", authentication: "none", description: "Research official Microsoft documentation" }] });
      case "_supercharge/plugins/details": return ok({ plugin: plugins.find((plugin) => plugin.id === p.id), servers: [{ name: "github", endpoint: "https://api.githubcopilot.com/mcp/", permission: "remote_service_access" }], hooks: 0 });
      case "_supercharge/plugins/list": return ok({ plugins });
      case "_supercharge/plugins/action": {
        const a = p.action;
        if (a.type === "install") { const name = a.source.replace("starter:", ""); if (!plugins.some((p) => p.name === name)) plugins.push({ id: name, name, version: "1.0.0", enabled: false, trusted: true, skillNames: ["release-brief"], mcpServerCount: 1 }); }
        if (a.type === "uninstall") plugins = plugins.filter((p) => p.id !== a.plugin_id);
        if (["enable", "disable"].includes(a.type)) { const plugin = plugins.find((p) => p.id === a.plugin_id); if (plugin) plugin.enabled = a.type === "enable"; }
        return ok({ status: "success", message: "Saved on fixture agent", requiresReload: a.type === "install" });
      }
      case "_supercharge/connections/list": return ok({ accounts });
      case "_supercharge/connections/configure": {
        if (!plugins.some((a) => a.name === p.plugin)) return { result: null, error: "Plugin not found" };
        accounts = [{ id: "account-fixture", plugin: p.plugin, server: p.server, origin: "https://api.githubcopilot.com/mcp/", account: p.account, active: true, secretKind: p.secretKind, secretBackend: "file" }];
        return ok({ status: "success" });
      }
      case "_supercharge/connections/select": return ok({ status: "success" });
      case "_supercharge/connections/disconnect": accounts = []; return ok({ status: "success", providerRevocation: "not_supported" });
      case "_supercharge/connections/connect": return ok({ status: "pending" });
      case "_supercharge/connections/status": return ok({ status: "authenticated" });
      case "_supercharge/connections/cancel": return ok({ status: "cancelled" });
      case "_supercharge/mcp/list": return ok({ servers: plugins.filter((p) => p.enabled).map((p) => ({ name: `plugin-${p.name}`, source: "local", session: { status: "ready", authRequired: accounts.some((a) => a.secretKind === "oauth"), tools: [{ name: "safe_read" }] } })) });
    }
  };
}
