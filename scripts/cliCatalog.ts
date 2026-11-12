/**
 * Test and fake-agent fixture: the CLI's `setup/status` `providers` catalog, in the CLI's own shape
 * (formats openai/anthropic/responses, legacy `auth`, `authMethods`, `keyOptional` for local servers).
 * Not shipped in the app: Studio shows whatever catalog the CLI sends.
 */
export const CLI_CATALOG = [
  { id: "pollinations", name: "Pollinations", description: "Recommended — large free/cheap model list", baseUrl: "https://gen.pollinations.ai/v1", defaultModel: "openai", format: "openai", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "openai", name: "OpenAI", description: "api.openai.com", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5.4", format: "openai", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "anthropic", name: "Anthropic", description: "Claude via the Anthropic Messages API", baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-4-6", format: "anthropic", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "openrouter", name: "OpenRouter", description: "Pay-per-use multi-provider aggregator", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "anthropic/claude-sonnet-4-6", format: "openai", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "deepseek", name: "DeepSeek", description: "V4 / chat / reasoner", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", format: "openai", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "google", name: "Google AI Studio", description: "Gemini via OpenAI-compatible endpoint", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.5-pro", format: "openai", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "groq", name: "Groq", description: "Fast Llama inference", baseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile", format: "openai", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "zai", name: "Z.AI / GLM", description: "Zhipu GLM direct API", baseUrl: "https://api.z.ai/api/paas/v4", defaultModel: "glm-5.1", format: "openai", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "kimi-coding", name: "Kimi Coding", description: "Moonshot OpenAI-compatible", baseUrl: "https://api.moonshot.ai/v1", defaultModel: "kimi-k2.6", format: "openai", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "kimi", name: "Moonshot (Kimi Anthropic)", description: "Kimi via Anthropic-compatible endpoint", baseUrl: "https://api.moonshot.ai/anthropic", defaultModel: "kimi-k2.6", format: "anthropic", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "qwen", name: "Qwen Cloud", description: "DashScope OpenAI-compatible", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen3.6-plus", format: "openai", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "mistral", name: "Mistral AI", description: "Mistral / Codestral", baseUrl: "https://api.mistral.ai/v1", defaultModel: "mistral-large-latest", format: "openai", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "together", name: "Together AI", description: "Open models inference", baseUrl: "https://api.together.xyz/v1", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", format: "openai", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "fireworks", name: "Fireworks AI", description: "OpenAI-compatible hosted models", baseUrl: "https://api.fireworks.ai/inference/v1", defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct", format: "openai", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "grok", name: "xAI (Grok)", description: "Grok direct API", baseUrl: "https://api.x.ai/v1", defaultModel: "grok-4-0709", format: "openai", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "routingrun", name: "Routing.run", description: "Open-source model routing", baseUrl: "https://api.routing.run/v1", defaultModel: "route/glm-5.1", format: "openai", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "zenllm", name: "ZenLLM", description: "200+ model aggregator", baseUrl: "https://api.zenllm.org/v1", defaultModel: "zhipu/glm-5.1", format: "openai", curated: true, auth: "api_key", authMethods: ["api_key"] },
  { id: "nous", name: "Nous Research", description: "Nous Portal OAuth — free-tier models", baseUrl: "https://inference-api.nousresearch.com/v1", defaultModel: "Hermes-4.3-36B", format: "openai", curated: true, auth: "oauth_device", authMethods: ["device"] },
  { id: "ollama", name: "Ollama (local)", description: "Local OpenAI-compatible server, key optional", baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "llama3.3", format: "openai", curated: true, auth: "api_key", authMethods: ["none", "api_key"], keyOptional: true },
  { id: "lmstudio", name: "LM Studio", description: "Local desktop server, key optional", baseUrl: "http://127.0.0.1:1234/v1", defaultModel: "local-model", format: "openai", curated: true, auth: "api_key", authMethods: ["none", "api_key"], keyOptional: true },
];
