import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { z } from "zod";
import { tryDeterministic, type DpdLite } from "./deterministic-extractors";
import { callProvider, type Provider, type LlmConfig } from "./llm-provider-call";

type ModelOverride = {
  provider?: Provider;
  apiKey?: string;
  endpoint?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
};


// --------- Pricing table (rough; per 1M tokens, USD) ----------
const PRICING: Record<string, { in: number; out: number }> = {
  "google/gemini-3-flash-preview": { in: 0.1, out: 0.4 },
  "google/gemini-3.1-flash-lite": { in: 0.05, out: 0.2 },
  "google/gemini-3.5-flash": { in: 0.1, out: 0.4 },
  "google/gemini-2.5-flash": { in: 0.075, out: 0.3 },
  "google/gemini-2.5-pro": { in: 1.25, out: 5 },
  "openai/gpt-5-mini": { in: 0.25, out: 2 },
  "openai/gpt-5-nano": { in: 0.05, out: 0.4 },
};

function estimateCost(model: string, inT: number, outT: number) {
  const p = PRICING[model] ?? { in: 0.1, out: 0.4 };
  return (inT * p.in + outT * p.out) / 1_000_000;
}

function getSb() {
  return createClient<Database>(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
  );
}

type GatewayResult = {
  content: string;
  inputTokens: number;
  outputTokens: number;
  latency: number;
};

async function callGateway(opts: {
  provider?: Provider;
  apiKey?: string;
  endpoint?: string;
  model: string;
  temperature: number;
  maxTokens: number;
  system?: string;
  user: string;
  jsonMode?: boolean;
}): Promise<GatewayResult> {
  const cfg: LlmConfig = {
    provider: opts.provider ?? "lovable",
    apiKey: opts.apiKey,
    endpoint: opts.endpoint,
    model: opts.model,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
  };
  return callProvider(cfg, { system: opts.system, user: opts.user, jsonMode: opts.jsonMode });
}

function parseJsonLenient(text: string): unknown {
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s);
}

// ----- topic classification (alias-first, LLM fallback) -----
type TopicLite = {
  topicId: string;
  defId: string;
  slug: string;
  name: string;
  description: string;
  aliases: string[];
};

function aliasMatch(chunk: string, topics: TopicLite[]): string[] {
  const text = " " + chunk.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") + " ";
  const found = new Set<string>();
  for (const t of topics) {
    const candidates = [t.slug, t.name, ...t.aliases].filter(Boolean);
    for (const kw of candidates) {
      const norm = kw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (norm.length < 3) continue;
      // word-boundary-ish match
      const re = new RegExp(`[^a-z0-9]${norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^a-z0-9]`);
      if (re.test(text)) { found.add(t.slug); break; }
    }
  }
  return Array.from(found);
}

async function classifyChunkWithLLM(
  chunk: string,
  topics: TopicLite[],
  model: string,
  temperature: number,
  override?: ModelOverride,
): Promise<{ slugs: string[]; inT: number; outT: number; latency: number; cost: number }> {
  const list = topics.map((t) => `- ${t.slug}: ${t.description || t.name}`).join("\n");
  const sys =
    "Você classifica trechos de texto em tópicos hoteleiros. Responda EXCLUSIVAMENTE com JSON {\"topics\":[\"slug1\",\"slug2\"]}. Use somente os slugs listados. Se nenhum tópico se aplica, devolva [].";
  const user = `TÓPICOS DISPONÍVEIS:\n${list}\n\nTEXTO:\n"""${chunk.slice(0, 1200)}"""`;
  const res = await callGateway({
    provider: override?.provider, apiKey: override?.apiKey, endpoint: override?.endpoint,
    model, temperature, maxTokens: 200, system: sys, user, jsonMode: true,
  });
  let slugs: string[] = [];
  try {
    const parsed = parseJsonLenient(res.content) as { topics?: unknown };
    if (Array.isArray(parsed.topics)) {
      slugs = parsed.topics.filter((s): s is string => typeof s === "string");
    }
  } catch { /* ignore */ }
  const valid = new Set(topics.map((t) => t.slug));
  slugs = slugs.filter((s) => valid.has(s));
  return {
    slugs,
    inT: res.inputTokens,
    outT: res.outputTokens,
    latency: res.latency,
    cost: estimateCost(model, res.inputTokens, res.outputTokens),
  };
}

// ----- Per (chunk, topic) extraction schema -----
const CoreFieldSchema = z.object({
  field_name: z.string(),
  field_value: z.any(),
  confidence: z.number().min(0).max(1).optional(),
});
const DynamicFieldSchema = z.object({
  field_name: z.string(),
  field_type: z.enum(["text", "boolean", "number", "currency", "time", "time_range", "multi_select"]),
  field_value: z.any(),
  confidence: z.number().min(0).max(1).optional(),
});
const ExtractionSchema = z.object({
  core_fields: z.array(CoreFieldSchema).default([]),
  dynamic_fields: z.array(DynamicFieldSchema).default([]),
  additional_information: z.array(z.string()).default([]),
});
type Extraction = z.infer<typeof ExtractionSchema>;


function renderPrompt(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

async function assertDb<T>(
  op: PromiseLike<{ data: T | null; error: { message: string } | null }>,
  label: string,
): Promise<T | null> {
  const { data, error } = await op;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

// ----- Field-name normalization (used to dedupe dynamic vs core) -----
const PT_STOPWORDS = new Set(["de", "da", "do", "das", "dos", "a", "o", "e", "em", "para", "the", "of"]);
function normalizeFieldKey(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}
function tokensFieldKey(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !PT_STOPWORDS.has(t))
    .join("");
}
function fieldKeyVariants(s: string): string[] {
  const set = new Set<string>();
  const n = normalizeFieldKey(s);
  const t = tokensFieldKey(s);
  if (n) set.add(n);
  if (t) set.add(t);
  return Array.from(set);
}

// =====================================================
// runExtraction (Etapa 2 — DataPoint-aware)
// =====================================================
export const runExtraction = createServerFn({ method: "POST" })
  .inputValidator((input: {
    projectId: string;
    mode: "dry_run" | "persist";
    chunkIds?: string[];
    modelOverride?: ModelOverride;
  }) => input)
  .handler(async ({ data }) => {
    const sb = getSb();



    // Project + sources + chunks
    const { data: project } = await sb
      .from("projects").select("id, name").eq("id", data.projectId).maybeSingle();
    if (!project) throw new Error("Projeto não encontrado");

    const { data: sources } = await sb
      .from("raw_sources").select("id").eq("project_id", data.projectId);
    const sourceIds = (sources ?? []).map((s) => s.id);
    if (sourceIds.length === 0) throw new Error("Nenhuma fonte bruta. Faça upload de um CSV primeiro.");

    // Settings (por projeto)
    const { data: settings } = await sb
      .from("extraction_settings").select("*").eq("project_id", data.projectId).maybeSingle();
    if (!settings) throw new Error("Configuração de extração ausente. Inicialize-a em Settings → Extraction Pipeline.");

    const { data: modelCfg } = await sb
      .from("model_configurations").select("*").eq("active", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!modelCfg && !data.modelOverride?.model) {
      throw new Error(
        "Nenhum modelo ativo configurado. Configure um modelo em Settings → Model Configurations, " +
        "ou defina provider/modelo na aba Extraction Pipeline do projeto.",
      );
    }

    const effModel = data.modelOverride?.model?.trim() || modelCfg!.model_name;
    const effTemp = data.modelOverride?.temperature ?? Number(settings.temperature);
    const effMaxTokens = data.modelOverride?.maxTokens ?? modelCfg?.max_tokens ?? 2048;
    const unifiedPrompt = (settings as { unified_prompt?: string | null }).unified_prompt?.trim()
      || `${settings.system_prompt ?? ""}\n\n${settings.extraction_prompt ?? ""}`.trim();

    let chunkQuery = sb
      .from("raw_chunks").select("id, content").in("raw_source_id", sourceIds).order("position");
    if (data.chunkIds && data.chunkIds.length > 0) {
      chunkQuery = sb
        .from("raw_chunks").select("id, content").in("id", data.chunkIds).order("position");
    }
    const { data: chunksRaw } = await chunkQuery;
    const allChunks = chunksRaw ?? [];
    // Process every available chunk — Process Knowledge is the sole re-extraction entry point
    // now, so it must actually cover the whole active source, not a "settings.max_chunks" sample.
    const chunks = allChunks;

    if (chunks.length === 0) throw new Error("Nenhum chunk encontrado.");

    // Topics in this project (with definitions + aliases)
    const { data: topicsRaw } = await sb
      .from("topics")
      .select("id, topic_definition_id, topic_definitions(slug, name, description, aliases)")
      .eq("project_id", data.projectId);
    const topics: TopicLite[] = (topicsRaw ?? []).map((t) => {
      const td = t.topic_definitions as {
        slug: string; name: string; description: string | null; aliases: string[];
      } | null;
      return {
        topicId: t.id,
        defId: t.topic_definition_id,
        slug: td?.slug ?? "",
        name: td?.name ?? "",
        description: td?.description ?? "",
        aliases: td?.aliases ?? [],
      };
    });
    if (topics.length === 0) throw new Error("Nenhum tópico ativo. Ative tópicos na aba Topics.");
    const topicBySlug = new Map(topics.map((t) => [t.slug, t]));

    // Persist mode is a full reset+rebuild: wipe whatever structured knowledge already exists
    // for this project's topics BEFORE extracting, so the result reflects ONLY the currently
    // active source(s) — not a merge with data left over from a source that was since deleted.
    if (data.mode === "persist") {
      const topicIds = topics.map((t) => t.topicId);
      if (topicIds.length > 0) {
        await sb.from("knowledge_fields").delete().in("topic_id", topicIds);
        await sb.from("additional_info").delete().in("topic_id", topicIds);
      }
      await sb.from("knowledge_candidates").delete().eq("project_id", data.projectId);
      await sb.from("knowledge_conflicts").delete().eq("project_id", data.projectId);
    }

    // Data point definitions (only for active definitions)
    const defIds = topics.map((t) => t.defId);
    const { data: dpdRaw } = await sb
      .from("data_point_definitions").select("*").in("topic_definition_id", defIds).eq("active", true);
    type DpdFull = DpdLite & { field_label: string; description: string | null };
    const dpdByDefId = new Map<string, DpdFull[]>();
    for (const d of dpdRaw ?? []) {
      const list = dpdByDefId.get(d.topic_definition_id) ?? [];
      list.push({
        field_name: d.field_name,
        field_label: d.field_label,
        field_type: d.field_type,
        description: d.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        extraction_strategy: (d as any).extraction_strategy ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        regex_pattern: (d as any).regex_pattern ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        keywords: (d as any).keywords ?? {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        negative_keywords: (d as any).negative_keywords ?? [],
      });
      dpdByDefId.set(d.topic_definition_id, list);
    }


    // Create the extraction_run row
    const { data: run, error: runErr } = await sb
      .from("extraction_runs")
      .insert({
        project_id: data.projectId,
        raw_source_ids: sourceIds,
        mode: data.mode,
        model_configuration_id: modelCfg?.id ?? null,
        status: "running",
        started_at: new Date().toISOString(),
      })
      .select("*").single();
    if (runErr || !run) throw new Error(runErr?.message ?? "Falha ao criar run");

    // Aggregation buckets per topic
    type ExtractionMethod = "regex" | "keyword" | "llm";
    type TopicAggregate = {
      topic_slug: string;
      topic_name: string;
      topic_def_id: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core_fields: Array<{ field_name: string; field_value: any; confidence?: number; source_chunk_ids: string[]; extraction_method: ExtractionMethod }>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dynamic_fields: Array<{ field_name: string; field_type: string; field_value: any; confidence?: number; source_chunk_ids: string[]; extraction_method: ExtractionMethod }>;

      additional_information: Array<{ content: string; source_chunk_ids: string[] }>;
    };
    const agg = new Map<string, TopicAggregate>();
    for (const t of topics) {
      agg.set(t.slug, {
        topic_slug: t.slug,
        topic_name: t.name,
        topic_def_id: t.defId,
        core_fields: [],
        dynamic_fields: [],
        additional_information: [],
      });
    }

    let totalIn = 0, totalOut = 0, totalCost = 0, totalLatency = 0;
    const chunkTopicMap: Record<string, { matched: string[]; via: "alias" | "llm" | "none" }> = {};
    const classifyCalls = { alias: 0, llm: 0, none: 0 };
    const detStats = {
      regex_fields: 0,
      keyword_fields: 0,
      llm_fields: 0,
      chunks_skipped_llm: 0,
      chunks_sent_to_llm: 0,
      estimated_llm_calls_saved: 0,
    };
    const useLlmForDynamic = (settings as { use_llm_for_dynamic?: boolean }).use_llm_for_dynamic ?? true;


    try {
      for (const chunk of chunks) {
        // Step 1: alias classification
        let matched = aliasMatch(chunk.content, topics);
        let via: "alias" | "llm" | "none" = "alias";
        if (matched.length === 0) {
          // Step 2: LLM classification
          const c = await classifyChunkWithLLM(chunk.content, topics, effModel, effTemp, data.modelOverride);
          totalIn += c.inT; totalOut += c.outT; totalCost += c.cost; totalLatency += c.latency;
          await sb.from("llm_calls").insert({
            prompt_type: "classify",
            model_name: effModel,
            input_tokens: c.inT, output_tokens: c.outT, latency: c.latency, estimated_cost: c.cost,
            extraction_run_id: run.id,
          });
          matched = c.slugs;
          via = matched.length > 0 ? "llm" : "none";
        }
        chunkTopicMap[chunk.id] = { matched, via };
        classifyCalls[via]++;

        if (matched.length === 0) continue;

        // Step 3: per (chunk, topic) extraction
        for (const slug of matched) {
          const topic = topicBySlug.get(slug);
          if (!topic) continue;
          const dps = dpdByDefId.get(topic.defId) ?? [];
          const bucket = agg.get(slug)!;

          // 3a) Deterministic pass on every DPD (regex/keyword/hybrid).
          const resolvedCore = new Set<string>();
          for (const d of dps) {
            const det = tryDeterministic(d, chunk.content);
            if (det) {
              bucket.core_fields.push({
                field_name: d.field_name,
                field_value: det.value,
                confidence: 0.95,
                source_chunk_ids: [chunk.id],
                extraction_method: det.method,
              });
              resolvedCore.add(d.field_name);
              if (det.method === "regex") detStats.regex_fields++;
              else detStats.keyword_fields++;
            }
          }

          // 3b) Decide if we need LLM at all for this (chunk, topic).
          const unresolvedDps = dps.filter((d) => !resolvedCore.has(d.field_name));
          // Strategies that still want LLM when unresolved: 'hybrid' (no det match) or 'llm'.
          const unresolvedNeedsLLM = unresolvedDps.filter((d) => {
            const strat = d.extraction_strategy ?? null;
            if (strat === "regex" || strat === "keyword") return false; // strict — no LLM fallback
            return true; // hybrid + llm + null(default text/multi_select → llm)
          });
          const needLLM = unresolvedNeedsLLM.length > 0 || useLlmForDynamic;

          if (!needLLM) {
            detStats.chunks_skipped_llm++;
            detStats.estimated_llm_calls_saved++;
            continue;
          }
          detStats.chunks_sent_to_llm++;

          // 3c) Build prompt — only list DPs the LLM should still try.
          const llmDpBlock = unresolvedNeedsLLM.length === 0
            ? "(todos os data points oficiais já foram preenchidos por regra determinística — extraia somente dynamic_fields e additional_information)"
            : unresolvedNeedsLLM.map((d) => `- ${d.field_name} (${d.field_type})${d.description ? `: ${d.description}` : ""}`).join("\n");

          const userPrompt = renderPrompt(unifiedPrompt, {
            topic_slug: topic.slug,
            topic_name: topic.name,
            topic_description: topic.description,
            data_points: llmDpBlock,
            chunk: chunk.content,
          });

          // A fixed 2048-token cap truncates the JSON response for topics with many data
          // points, which fails to parse and silently drops the whole result for that
          // (chunk, topic) pair — scale the cap with how many fields are still unresolved.
          const chunkTopicMaxTokens = Math.max(effMaxTokens, unresolvedNeedsLLM.length * 250 + 700);

          const res = await callGateway({
            provider: data.modelOverride?.provider,
            apiKey: data.modelOverride?.apiKey,
            endpoint: data.modelOverride?.endpoint,
            model: effModel,
            temperature: effTemp,
            maxTokens: chunkTopicMaxTokens,
            user: userPrompt,
            jsonMode: true,
          });
          const cost = estimateCost(effModel, res.inputTokens, res.outputTokens);
          totalIn += res.inputTokens; totalOut += res.outputTokens;
          totalCost += cost; totalLatency += res.latency;

          await sb.from("llm_calls").insert({
            prompt_type: `extract:${topic.slug}`,
            model_name: effModel,
            input_tokens: res.inputTokens,
            output_tokens: res.outputTokens,
            latency: res.latency,
            estimated_cost: cost,
            extraction_run_id: run.id,
          });

          let parsed: Extraction = { core_fields: [], dynamic_fields: [], additional_information: [] };
          try {
            parsed = ExtractionSchema.parse(parseJsonLenient(res.content));
          } catch (e) {
            console.error("Parse fail", topic.slug, chunk.id, e);
          }

          const allowedCore = new Set(dps.map((d) => d.field_name));
          // Build alias index: normalized variant -> canonical field_name
          const coreAlias = new Map<string, string>();
          for (const d of dps) {
            for (const v of fieldKeyVariants(d.field_name)) coreAlias.set(v, d.field_name);
            for (const v of fieldKeyVariants(d.field_label)) coreAlias.set(v, d.field_name);
          }
          const resolveToCore = (name: string): string | null => {
            if (allowedCore.has(name)) return name;
            for (const v of fieldKeyVariants(name)) {
              const hit = coreAlias.get(v);
              if (hit) return hit;
            }
            return null;
          };

          for (const f of parsed.core_fields) {
            if (isEmptyValue(f.field_value)) continue;
            const canonical = resolveToCore(f.field_name);
            if (!canonical) continue;
            if (resolvedCore.has(canonical)) continue; // deterministic wins
            bucket.core_fields.push({
              field_name: canonical,
              field_value: f.field_value,
              confidence: f.confidence,
              source_chunk_ids: [chunk.id],
              extraction_method: "llm",
            });
            detStats.llm_fields++;
          }
          if (useLlmForDynamic) {
            for (const f of parsed.dynamic_fields) {
              if (isEmptyValue(f.field_value)) continue;
              // If the dynamic name matches a core field (exact or via normalized variants), promote to core.
              const canonical = resolveToCore(f.field_name);
              if (canonical) {
                if (resolvedCore.has(canonical)) continue;
                if (bucket.core_fields.some((c) => c.field_name === canonical && c.source_chunk_ids[0] === chunk.id)) continue;
                bucket.core_fields.push({
                  field_name: canonical,
                  field_value: f.field_value,
                  confidence: f.confidence,
                  source_chunk_ids: [chunk.id],
                  extraction_method: "llm",
                });
                detStats.llm_fields++;
                continue;
              }
              bucket.dynamic_fields.push({
                field_name: f.field_name,
                field_type: f.field_type,
                field_value: f.field_value,
                confidence: f.confidence,
                source_chunk_ids: [chunk.id],
                extraction_method: "llm",
              });
              detStats.llm_fields++;
            }
            for (const text of parsed.additional_information) {
              const t = (text ?? "").trim();
              if (!t) continue;
              bucket.additional_information.push({ content: t, source_chunk_ids: [chunk.id] });
            }
          }
        }
      }

      // Build preview shape

      const previewTopics = Array.from(agg.values())
        .filter((b) => b.core_fields.length > 0 || b.dynamic_fields.length > 0 || b.additional_information.length > 0)
        .map((b) => ({
          topic_slug: b.topic_slug,
          topic_name: b.topic_name,
          core_fields: b.core_fields,
          dynamic_fields: b.dynamic_fields,
          additional_information: b.additional_information,
        }));

      const totalCore = previewTopics.reduce((s, t) => s + t.core_fields.length, 0);
      const totalDyn = previewTopics.reduce((s, t) => s + t.dynamic_fields.length, 0);
      const totalAdd = previewTopics.reduce((s, t) => s + t.additional_information.length, 0);

      const stats = {
        chunks_processed: chunks.length,
        chunks_total: allChunks.length,
        topics_with_data: previewTopics.length,
        core_fields_found: totalCore,
        dynamic_fields_found: totalDyn,
        additional_info_found: totalAdd,
        input_tokens: totalIn,
        output_tokens: totalOut,
        estimated_cost: totalCost,
        latency_ms: totalLatency,
        classify_alias_hits: classifyCalls.alias,
        classify_llm_calls: classifyCalls.llm,
        classify_unmatched: classifyCalls.none,
        deterministic_extraction: detStats,
      };


      // ---- Persist mode (Etapa 4): salva apenas candidates + additional_info pending.
      //  Consolidação em KnowledgeFields é responsabilidade de consolidateKnowledge.
      let persisted = { candidates: 0, additional_info: 0 };
      if (data.mode === "persist") {
        for (const t of previewTopics) {
          const topic = topicBySlug.get(t.topic_slug);
          if (!topic) continue;

          const allFields = [
            ...t.core_fields.map((f) => ({ ...f, field_type: "text", field_origin: "core" as const })),
            ...t.dynamic_fields.map((f) => ({ ...f, field_origin: "dynamic" as const })),
          ];

          for (const f of allFields) {
            await sb.from("knowledge_candidates").insert({
              project_id: data.projectId,
              extraction_run_id: run.id,
              topic_definition_id: topic.defId,
              field_name: f.field_name,
              field_type: f.field_type,
              field_value: (f.field_value ?? null) as never,
              field_origin: f.field_origin,
              confidence: f.confidence ?? null,
              source_chunk_ids: f.source_chunk_ids as never,
              status: "pending",
              extraction_method: f.extraction_method,
            } as never);
            persisted.candidates++;
          }

          // Additional info — dedupe by content; entra como pending para aprovação.
          const { data: existingAdd } = await sb
            .from("additional_info").select("id, content").eq("topic_id", topic.topicId);
          const existingAddSet = new Set((existingAdd ?? []).map((a) => a.content.trim().toLowerCase()));
          for (const a of t.additional_information) {
            if (existingAddSet.has(a.content.trim().toLowerCase())) continue;
            await sb.from("additional_info").insert({
              topic_id: topic.topicId,
              content: a.content,
              source_chunk_ids: a.source_chunk_ids as never,
              status: "pending",
            } as never);
            existingAddSet.add(a.content.trim().toLowerCase());
            persisted.additional_info++;
          }
        }
      }

      // --- Update raw_chunks.extraction_status (only in persist mode) ---
      if (data.mode === "persist") {
        const extractedChunkIds = new Set<string>();
        for (const b of agg.values()) {
          for (const f of b.core_fields) f.source_chunk_ids.forEach((id) => extractedChunkIds.add(id));
          for (const f of b.dynamic_fields) f.source_chunk_ids.forEach((id) => extractedChunkIds.add(id));
          for (const a of b.additional_information) a.source_chunk_ids.forEach((id) => extractedChunkIds.add(id));
        }
        const processedIds = chunks.map((c) => c.id);
        const noKnowledgeIds = processedIds.filter((id) => !extractedChunkIds.has(id));
        if (extractedChunkIds.size > 0) {
          await sb.from("raw_chunks").update({ extraction_status: "extracted" } as never)
            .in("id", Array.from(extractedChunkIds));
        }
        if (noKnowledgeIds.length > 0) {
          // Don't overwrite manually-marked irrelevant chunks
          await sb.from("raw_chunks").update({ extraction_status: "no_knowledge_found" } as never)
            .in("id", noKnowledgeIds)
            .neq("extraction_status", "marked_irrelevant");
        }
      }

      const preview = { topics: previewTopics, chunk_topics: chunkTopicMap, statistics: stats, persisted };


      await sb.from("extraction_runs").update({
        status: "done",
        finished_at: new Date().toISOString(),
        preview_result: preview as never,
        stats: stats as never,
      }).eq("id", run.id);

      return { runId: run.id, mode: data.mode, preview, stats, persisted };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sb.from("extraction_runs").update({
        status: "failed", finished_at: new Date().toISOString(), error: msg,
      }).eq("id", run.id);
      throw err;
    }
  });

// =====================================================
// Persist a previous dry-run by re-running in persist mode.
// (Simple version: starts a new persist run from current state.)
// =====================================================
export const persistRun = createServerFn({ method: "POST" })
  .inputValidator((input: { projectId: string }) => input)
  .handler(async ({ data }) => {
    return { ok: true, hint: "Use runExtraction com mode=persist", projectId: data.projectId };
  });

