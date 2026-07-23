import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  callProvider as callProviderRaw,
  listModels as listModelsRaw,
  type Provider,
  type LlmConfig as BaseLlmConfig,
  type ModelInfo,
} from "./llm-provider-call";

function getSb() {
  return createClient<Database>(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
  );
}

type CallResult = {
  answer: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
};

type LlmConfig = BaseLlmConfig & { system?: string };

const DEFAULT_SYSTEM =
  "Você é um assistente de hotel. Responda APENAS com base no contexto fornecido. Se a informação não estiver no contexto, diga que não encontrou. Não invente.";

function buildUserPrompt(question: string, context: string) {
  return `CONTEXTO:\n${context}\n\nPERGUNTA:\n${question}`;
}

async function callProvider(cfg: LlmConfig, userPrompt: string): Promise<CallResult> {
  const res = await callProviderRaw(cfg, { system: cfg.system || DEFAULT_SYSTEM, user: userPrompt });
  return {
    answer: res.content,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    latencyMs: res.latency,
  };
}

// ===== Context builders =====

function normalizeText(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

async function buildRawContext(
  sb: ReturnType<typeof getSb>,
  projectId: string,
  question: string,
  maxChunks: number,
): Promise<{ text: string; chunksUsed: number; chunks: Array<{ id: string; source: string }> }> {
  const { data: sources } = await sb
    .from("raw_sources").select("id, filename").eq("project_id", projectId);
  const sourceIds = (sources ?? []).map((s) => s.id);
  if (sourceIds.length === 0) return { text: "(sem fontes)", chunksUsed: 0, chunks: [] };
  const nameById = new Map((sources ?? []).map((s) => [s.id, s.filename ?? "?"]));

  const { data: chunks } = await sb
    .from("raw_chunks").select("id, content, raw_source_id, position")
    .in("raw_source_id", sourceIds).order("position").limit(1000);
  const all = chunks ?? [];
  if (all.length === 0) return { text: "(sem chunks)", chunksUsed: 0, chunks: [] };

  const qTokens = normalizeText(question)
    .replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4);
  const scored = all.map((c) => {
    const norm = normalizeText(c.content);
    let score = 0;
    for (const t of qTokens) if (norm.includes(t)) score += t.length >= 5 ? 2 : 1;
    return { id: c.id, content: c.content, source: nameById.get(c.raw_source_id) ?? "?", score };
  });
  let selected = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (selected.length === 0) selected = scored.slice(0, maxChunks);
  selected = selected.slice(0, maxChunks);

  const text = selected.map((s) => `# Fonte: ${s.source}\n${s.content}`).join("\n---\n");
  return {
    text,
    chunksUsed: selected.length,
    chunks: selected.map((s) => ({ id: s.id, source: s.source })),
  };
}

async function buildStructuredContext(
  sb: ReturnType<typeof getSb>,
  projectId: string,
  question: string,
): Promise<{ text: string; fieldsUsed: number; topicsUsed: number; matchedTopics: string[] }> {
  const { data: topics } = await sb
    .from("topics")
    .select("id, topic_definitions(slug, name, aliases)")
    .eq("project_id", projectId);
  const topicList = (topics ?? []) as unknown as Array<{
    id: string;
    topic_definitions: { slug: string; name: string; aliases: string[] | null } | null;
  }>;
  if (topicList.length === 0) return { text: "(sem tópicos)", fieldsUsed: 0, topicsUsed: 0, matchedTopics: [] };

  // Topic relevance filter — match question against slug/name/aliases.
  const qNorm = normalizeText(question);
  const qTokens = qNorm.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3);
  const scoredTopics = topicList.map((t) => {
    const def = t.topic_definitions;
    const terms = [def?.slug, def?.name, ...(def?.aliases ?? [])]
      .filter(Boolean)
      .map((s) => normalizeText(String(s)));
    let score = 0;
    for (const term of terms) {
      if (!term) continue;
      if (qNorm.includes(term)) score += term.length >= 5 ? 3 : 2;
      else {
        for (const tok of qTokens) {
          if (tok.length >= 4 && term.includes(tok)) score += 1;
        }
      }
    }
    return { t, score };
  });
  let relevant = scoredTopics.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (relevant.length === 0) relevant = scoredTopics.slice(0, 3);
  relevant = relevant.slice(0, 5);
  const selectedTopics = relevant.map((r) => r.t);
  const topicIds = selectedTopics.map((t) => t.id);

  const { data: fields } = await sb
    .from("knowledge_fields").select("topic_id, field_name, field_value, field_origin")
    .in("topic_id", topicIds)
    .eq("consolidation_status", "consolidated");
  const { data: addl } = await sb
    .from("additional_info").select("topic_id, content")
    .in("topic_id", topicIds).eq("status", "approved");

  type Payload = {
    topic: string;
    core_fields: Record<string, unknown>;
    additional_information: string;
  };
  const payloads: Payload[] = [];
  let totalFields = 0;
  const matchedSlugs: string[] = [];
  for (const t of selectedTopics) {
    const slug = t.topic_definitions?.slug ?? "?";
    const tFields = (fields ?? []).filter((f) => f.topic_id === t.id);
    const tAddl = (addl ?? []).filter((a) => a.topic_id === t.id);
    if (tFields.length === 0 && tAddl.length === 0) continue;
    const core: Record<string, unknown> = {};
    for (const f of tFields.filter((f) => f.field_origin === "core")) {
      core[f.field_name] = f.field_value;
      totalFields++;
    }
    const dynamicTexts = tFields
      .filter((f) => f.field_origin === "dynamic")
      .map((f) => {
        const v = typeof f.field_value === "object" ? JSON.stringify(f.field_value) : String(f.field_value);
        return `${f.field_name}: ${v}`;
      });
    totalFields += dynamicTexts.length;
    const addlText = [...tAddl.map((a) => a.content), ...dynamicTexts].join("\n");
    payloads.push({ topic: slug, core_fields: core, additional_information: addlText });
    matchedSlugs.push(slug);
  }
  if (payloads.length === 0) {
    return { text: "(nenhum tópico relevante encontrado)", fieldsUsed: 0, topicsUsed: 0, matchedTopics: [] };
  }
  return {
    text: JSON.stringify(payloads, null, 2),
    fieldsUsed: totalFields,
    topicsUsed: payloads.length,
    matchedTopics: matchedSlugs,
  };
}

// ===== Public server fn =====

/**
 * Lists models available for a provider/API key so the settings UI can offer
 * a dropdown instead of a free-text field. Runs server-side because the
 * provider APIs (OpenAI, Anthropic, Google) don't allow direct browser calls.
 */
export const listModels = createServerFn({ method: "POST" })
  .inputValidator((input: { provider: Provider; apiKey?: string }) => input)
  .handler(async ({ data }): Promise<ModelInfo[]> => listModelsRaw(data.provider, data.apiKey));

export const runCompare = createServerFn({ method: "POST" })
  .inputValidator((input: {
    projectId: string;
    question: string;
    provider: Provider;
    apiKey?: string;
    model: string;
    temperature: number;
    maxTokens: number;
    system?: string;
    endpoint?: string;
    maxChunks?: number;
  }) => input)
  .handler(async ({ data }) => {
    const sb = getSb();
    const maxChunks = Math.max(1, Math.min(80, data.maxChunks ?? 20));

    const [rawCtx, structCtx] = await Promise.all([
      buildRawContext(sb, data.projectId, data.question, maxChunks),
      buildStructuredContext(sb, data.projectId, data.question),
    ]);

    const cfg: LlmConfig = {
      provider: data.provider,
      apiKey: data.apiKey,
      model: data.model,
      temperature: data.temperature,
      maxTokens: data.maxTokens,
      system: data.system,
      endpoint: data.endpoint,
    };

    const rawPrompt = buildUserPrompt(data.question, rawCtx.text);
    const structPrompt = buildUserPrompt(data.question, structCtx.text);

    const [rawSettled, structSettled] = await Promise.allSettled([
      callProvider(cfg, rawPrompt),
      callProvider(cfg, structPrompt),
    ]);

    return {
      raw: {
        ok: rawSettled.status === "fulfilled",
        error: rawSettled.status === "rejected" ? String(rawSettled.reason?.message ?? rawSettled.reason) : null,
        ...(rawSettled.status === "fulfilled" ? rawSettled.value : { answer: "", inputTokens: null, outputTokens: null, latencyMs: 0 }),
        context: rawCtx.text,
        prompt: rawPrompt,
        chunksUsed: rawCtx.chunksUsed,
        chunks: rawCtx.chunks,
        contextChars: rawCtx.text.length,
      },
      structured: {
        ok: structSettled.status === "fulfilled",
        error: structSettled.status === "rejected" ? String(structSettled.reason?.message ?? structSettled.reason) : null,
        ...(structSettled.status === "fulfilled" ? structSettled.value : { answer: "", inputTokens: null, outputTokens: null, latencyMs: 0 }),
        context: structCtx.text,
        prompt: structPrompt,
        fieldsUsed: structCtx.fieldsUsed,
        topicsUsed: structCtx.topicsUsed,
        contextChars: structCtx.text.length,
      },
    };
  });
