// Shared multi-provider LLM caller — used by both extraction (ai.functions.ts)
// and Compare Responses (llm-providers.functions.ts) so a "provider" selected
// in the UI (openai/anthropic/google/openrouter/custom) actually gets called
// directly with the user-supplied key, instead of silently falling back to
// the Lovable AI Gateway.

import { costTierLabel } from "./llm-pricing";

export type Provider = "lovable" | "openai" | "anthropic" | "google" | "openrouter" | "custom";

export type CallResult = {
  content: string;
  inputTokens: number;
  outputTokens: number;
  latency: number;
};

export type LlmConfig = {
  provider: Provider;
  apiKey?: string;
  model: string;
  temperature: number;
  maxTokens: number;
  endpoint?: string;
};

type CallOpts = {
  system?: string;
  user: string;
  jsonMode?: boolean;
};

async function callOpenAICompat(
  cfg: LlmConfig,
  opts: CallOpts,
  endpoint: string,
  headers: Record<string, string>,
): Promise<CallResult> {
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.user });

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };

  const t0 = Date.now();
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const latency = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 429) throw new Error("Rate limit excedido. Tente novamente em instantes.");
    if (res.status === 402) throw new Error("Créditos/saldo esgotados no provider selecionado.");
    throw new Error(`Provider ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    content: json.choices?.[0]?.message?.content ?? "",
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
    latency,
  };
}

async function callAnthropic(cfg: LlmConfig, opts: CallOpts): Promise<CallResult> {
  if (!cfg.apiKey) throw new Error("API key obrigatória para Anthropic");
  const system = opts.jsonMode
    ? `${opts.system ?? ""}\n\nResponda EXCLUSIVAMENTE com um JSON válido, sem markdown ou texto adicional.`.trim()
    : opts.system;
  const t0 = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      temperature: cfg.temperature,
      system,
      messages: [{ role: "user", content: opts.user }],
    }),
  });
  const latency = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text) as {
    content?: Array<{ text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  return {
    content: (json.content ?? []).map((c) => c.text ?? "").join(""),
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
    latency,
  };
}

async function callGoogle(cfg: LlmConfig, opts: CallOpts): Promise<CallResult> {
  if (!cfg.apiKey) throw new Error("API key obrigatória para Google");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const generationConfig: Record<string, unknown> = {
    temperature: cfg.temperature,
    maxOutputTokens: cfg.maxTokens,
  };
  if (opts.jsonMode) generationConfig.responseMimeType = "application/json";

  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
      contents: [{ role: "user", parts: [{ text: opts.user }] }],
      generationConfig,
    }),
  });
  const latency = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) throw new Error(`Google ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  return {
    content: (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join(""),
    inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
    latency,
  };
}

export type ModelInfo = { id: string; label?: string; costTier?: string };

function sortByLabel(list: ModelInfo[]): ModelInfo[] {
  return [...list].sort((a, b) => (a.label || a.id).localeCompare(b.label || b.id));
}

// Attaches a cost-tier label (real price when we know it, else a name-based guess) and
// sorts alphabetically — shared by every provider except OpenRouter, which gets exact
// per-model pricing straight from its own /models response instead of our static table.
function withCostTier(provider: Provider, list: ModelInfo[]): ModelInfo[] {
  return sortByLabel(list.map((m) => ({ ...m, costTier: costTierLabel({ provider, model: m.id }) })));
}

export async function listModels(provider: Provider, apiKey?: string): Promise<ModelInfo[]> {
  switch (provider) {
    case "openai": {
      if (!apiKey) throw new Error("API key obrigatória para OpenAI");
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
      const json = JSON.parse(text) as { data?: Array<{ id: string }> };
      return withCostTier(
        provider,
        (json.data ?? []).map((m) => ({ id: m.id })).filter((m) => /gpt|^o[0-9]|chatgpt/i.test(m.id)),
      );
    }
    case "anthropic": {
      if (!apiKey) throw new Error("API key obrigatória para Anthropic");
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
      const json = JSON.parse(text) as { data?: Array<{ id: string; display_name?: string }> };
      return withCostTier(provider, (json.data ?? []).map((m) => ({ id: m.id, label: m.display_name })));
    }
    case "google": {
      if (!apiKey) throw new Error("API key obrigatória para Google");
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      );
      const text = await res.text();
      if (!res.ok) throw new Error(`Google ${res.status}: ${text.slice(0, 300)}`);
      const json = JSON.parse(text) as {
        models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
      };
      return withCostTier(
        provider,
        (json.models ?? [])
          .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
          .map((m) => ({ id: m.name.replace(/^models\//, ""), label: m.displayName })),
      );
    }
    case "openrouter": {
      const res = await fetch(
        "https://openrouter.ai/api/v1/models",
        apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined,
      );
      const text = await res.text();
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
      const json = JSON.parse(text) as {
        data?: Array<{ id: string; name?: string; pricing?: { prompt?: string; completion?: string } }>;
      };
      const list = (json.data ?? []).map((m) => {
        const inputUsd = Number(m.pricing?.prompt);
        const outputUsd = Number(m.pricing?.completion);
        const apiPriceUsdPerM = Number.isFinite(inputUsd) && Number.isFinite(outputUsd)
          ? { input: inputUsd * 1_000_000, output: outputUsd * 1_000_000 }
          : undefined;
        return {
          id: m.id,
          label: m.name,
          costTier: costTierLabel({ provider, model: m.id, apiPriceUsdPerM }),
        };
      });
      return sortByLabel(list);
    }
    default:
      return [];
  }
}

export async function callProvider(cfg: LlmConfig, opts: CallOpts): Promise<CallResult> {
  switch (cfg.provider) {
    case "lovable": {
      const apiKey = process.env.LOVABLE_API_KEY;
      if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");
      return callOpenAICompat(cfg, opts, "https://ai.gateway.lovable.dev/v1/chat/completions", {
        "Lovable-API-Key": apiKey,
      });
    }
    case "openai":
      if (!cfg.apiKey) throw new Error("API key obrigatória para OpenAI");
      return callOpenAICompat(cfg, opts, "https://api.openai.com/v1/chat/completions", {
        Authorization: `Bearer ${cfg.apiKey}`,
      });
    case "openrouter":
      if (!cfg.apiKey) throw new Error("API key obrigatória para OpenRouter");
      return callOpenAICompat(cfg, opts, "https://openrouter.ai/api/v1/chat/completions", {
        Authorization: `Bearer ${cfg.apiKey}`,
      });
    case "custom": {
      if (!cfg.endpoint) throw new Error("Endpoint obrigatório para Custom");
      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
      return callOpenAICompat(cfg, opts, cfg.endpoint, headers);
    }
    case "anthropic":
      return callAnthropic(cfg, opts);
    case "google":
      return callGoogle(cfg, opts);
  }
}
