// Preços em USD por 1M tokens (input, output). Estimativas — atualize conforme necessário.
type Provider = "lovable" | "openai" | "anthropic" | "google" | "openrouter" | "custom";

type Price = { input: number; output: number };

// Chave: `${provider}:${model}` (lowercase). Fallback por provider abaixo.
const PRICES: Record<string, Price> = {
  // Lovable AI Gateway
  "lovable:google/gemini-3-flash-preview": { input: 0.3, output: 2.5 },
  "lovable:google/gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "lovable:google/gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "lovable:google/gemini-2.5-pro": { input: 1.25, output: 10 },
  "lovable:openai/gpt-5-mini": { input: 0.25, output: 2 },
  "lovable:openai/gpt-5-nano": { input: 0.05, output: 0.4 },
  "lovable:openai/gpt-5": { input: 1.25, output: 10 },

  // OpenAI direto
  "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
  "openai:gpt-4o": { input: 2.5, output: 10 },
  "openai:gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "openai:gpt-4.1": { input: 2, output: 8 },

  // Anthropic
  "anthropic:claude-3-5-sonnet-latest": { input: 3, output: 15 },
  "anthropic:claude-3-5-haiku-latest": { input: 0.8, output: 4 },

  // Google Gemini API
  "google:gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "google:gemini-1.5-pro": { input: 1.25, output: 5 },
  "google:gemini-2.0-flash": { input: 0.1, output: 0.4 },

  // OpenRouter (roteia; usa preços do modelo subjacente quando conhecido)
  "openrouter:openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "openrouter:anthropic/claude-3.5-sonnet": { input: 3, output: 15 },
};

export function estimateCostUsd(params: {
  provider: Provider;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}): number | null {
  const { provider, model, inputTokens, outputTokens } = params;
  if (inputTokens == null && outputTokens == null) return null;
  const key = `${provider}:${model.toLowerCase()}`;
  const price = PRICES[key];
  if (!price) return null;
  const inTok = inputTokens ?? 0;
  const outTok = outputTokens ?? 0;
  return (inTok / 1_000_000) * price.input + (outTok / 1_000_000) * price.output;
}

export function formatUsd(usd: number | null): string {
  if (usd == null) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// ---- Cost tier for the model dropdown (Settings → Model) ----
// Thresholds in USD per 1M tokens, weighted toward output (real usage skews output-heavy).
const TIER_LOW_USD_PER_M = 0.5;
const TIER_HIGH_USD_PER_M = 3;

function blendedPrice(p: Price): number {
  return p.input * 0.25 + p.output * 0.75;
}

function tierFromPrice(p: Price): "menor" | "moderado" | "maior" {
  const blended = blendedPrice(p);
  if (blended < TIER_LOW_USD_PER_M) return "menor";
  if (blended <= TIER_HIGH_USD_PER_M) return "moderado";
  return "maior";
}

// Fallback for models we have no real price for — goes by common naming conventions
// across providers. Marked "(estimado)" in the label since it's a guess, not billed data.
function tierFromNameHeuristic(model: string): "menor" | "moderado" | "maior" {
  const n = model.toLowerCase();
  if (/\b(nano|lite|mini|haiku|flash-8b|8b|small)\b/.test(n)) return "menor";
  if (/\bopus\b|\bultra\b|\blarge\b|\b405b\b|\b70b\b|\bo1-preview\b|\bo1\b|\bo3\b|\bpro\b/.test(n)) return "maior";
  if (/gpt-5(?!-mini|-nano)/.test(n)) return "maior";
  return "moderado";
}

const TIER_LABEL = { menor: "Custo menor", moderado: "Custo moderado", maior: "Custo maior" } as const;

/** Cost-tier label for a model dropdown option. Uses real pricing when known, else a name-based guess. */
export function costTierLabel(params: {
  provider: Provider;
  model: string;
  apiPriceUsdPerM?: Price; // e.g. OpenRouter returns per-model pricing directly in its /models response
}): string {
  const { provider, model, apiPriceUsdPerM } = params;
  const known = apiPriceUsdPerM ?? PRICES[`${provider}:${model.toLowerCase()}`];
  if (known) return TIER_LABEL[tierFromPrice(known)];
  return `${TIER_LABEL[tierFromNameHeuristic(model)]} (estimado)`;
}
