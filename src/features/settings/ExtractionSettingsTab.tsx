import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ModelField } from "./ModelField";

type Provider = "lovable" | "openai" | "anthropic" | "google" | "openrouter" | "custom";

// Supabase's PostgrestError is a plain object (not an Error instance), so
// String(err) collapses to "[object Object]" — pull .message out explicitly.
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

const PROVIDER_DEFAULTS: Record<Provider, { model: string; needsKey: boolean; needsEndpoint: boolean }> = {
  lovable: { model: "google/gemini-3-flash-preview", needsKey: false, needsEndpoint: false },
  openai: { model: "gpt-4o-mini", needsKey: true, needsEndpoint: false },
  anthropic: { model: "claude-3-5-sonnet-latest", needsKey: true, needsEndpoint: false },
  google: { model: "gemini-1.5-flash", needsKey: true, needsEndpoint: false },
  openrouter: { model: "openai/gpt-4o-mini", needsKey: true, needsEndpoint: false },
  custom: { model: "gpt-4o-mini", needsKey: false, needsEndpoint: true },
};

export function extractionLlmKey(projectId: string) {
  return `hkb-extraction-llm:${projectId}`;
}

/**
 * Reads the LLM config saved by the "Modelo LLM (Extração)" card above and
 * turns it into the override forwarded to runExtraction.
 * Unlike Compare Responses' config, this one is honored for every provider —
 * not just "lovable" — since the whole point is letting the user extract
 * with their own OpenAI/Anthropic/Google/OpenRouter/custom key.
 */
export function getExtractionModelOverride(projectId: string):
  | { provider?: Provider; apiKey?: string; endpoint?: string; model?: string; temperature?: number }
  | undefined {
  try {
    const raw = localStorage.getItem(extractionLlmKey(projectId));
    if (!raw) return undefined;
    const c = JSON.parse(raw) as {
      provider?: Provider; apiKey?: string; endpoint?: string; model?: string; temperature?: string;
    };
    const t = c.temperature ? Number(c.temperature) : undefined;
    return {
      provider: c.provider,
      apiKey: c.apiKey?.trim() || undefined,
      endpoint: c.endpoint?.trim() || undefined,
      model: c.model?.trim() || undefined,
      temperature: Number.isFinite(t) ? t : undefined,
    };
  } catch {
    return undefined;
  }
}

export function ExtractionSettingsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { data, isLoading, error: queryError } = useQuery({
    queryKey: ["extraction_settings", projectId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("extraction_settings").select("*").eq("project_id", projectId).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Pipeline params (from Supabase)
  const [chunkSize, setChunkSize] = useState("");
  const [maxChunks, setMaxChunks] = useState("");
  const [temperature, setTemperature] = useState("");
  const [unifiedPrompt, setUnifiedPrompt] = useState("");
  const [useLlmForDynamic, setUseLlmForDynamic] = useState(true);
  const [saving, setSaving] = useState(false);
  const [initializing, setInitializing] = useState(false);

  // LLM config for extraction (from localStorage)
  const [provider, setProvider] = useState<Provider>("lovable");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(PROVIDER_DEFAULTS.lovable.model);
  const [llmTemperature, setLlmTemperature] = useState("0.0");
  const [endpoint, setEndpoint] = useState("");

  useEffect(() => {
    if (!data) return;
    setChunkSize(String(data.chunk_size));
    setMaxChunks(String(data.max_chunks));
    setTemperature(String(data.temperature));
    const d = data as typeof data & { unified_prompt?: string | null; use_llm_for_dynamic?: boolean };
    setUnifiedPrompt(
      d.unified_prompt && d.unified_prompt.trim().length > 0
        ? d.unified_prompt
        : `${data.system_prompt ?? ""}\n\n${data.extraction_prompt ?? ""}`.trim(),
    );
    setUseLlmForDynamic(d.use_llm_for_dynamic ?? true);
  }, [data]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(extractionLlmKey(projectId));
      if (!raw) return;
      const c = JSON.parse(raw);
      setProvider(c.provider ?? "lovable");
      setApiKey(c.apiKey ?? "");
      setModel(c.model ?? PROVIDER_DEFAULTS.lovable.model);
      setLlmTemperature(c.temperature ?? "0.0");
      setEndpoint(c.endpoint ?? "");
    } catch { /* ignore */ }
  }, [projectId]);

  function saveLlmConfig(next: Partial<{
    provider: Provider; apiKey: string; model: string; temperature: string; endpoint: string;
  }>) {
    const current = { provider, apiKey, model, temperature: llmTemperature, endpoint, ...next };
    localStorage.setItem(extractionLlmKey(projectId), JSON.stringify(current));
  }

  function onProviderChange(p: Provider) {
    setProvider(p);
    setModel(PROVIDER_DEFAULTS[p].model);
    saveLlmConfig({ provider: p, model: PROVIDER_DEFAULTS[p].model });
  }

  async function save() {
    if (!data) return;
    setSaving(true);
    const { error } = await supabase.from("extraction_settings").update({
      chunk_size: Number(chunkSize),
      max_chunks: Number(maxChunks),
      temperature: Number(temperature),
      unified_prompt: unifiedPrompt,
      use_llm_for_dynamic: useLlmForDynamic,
      updated_at: new Date().toISOString(),
    } as never).eq("id", data.id);
    setSaving(false);
    if (error) toast.error(error.message);
    else {
      toast.success("Configuração salva");
      qc.invalidateQueries({ queryKey: ["extraction_settings", projectId] });
    }
  }

  async function initializeSettings() {
    setInitializing(true);
    const { error } = await supabase.from("extraction_settings").insert({
      project_id: projectId,
      system_prompt: "",
      extraction_prompt: "",
      unified_prompt: "",
      chunk_size: 4000,
      max_chunks: 10,
      temperature: 0.0,
      use_llm_for_dynamic: true,
    } as never);
    setInitializing(false);
    if (error) {
      toast.error("Erro ao inicializar configurações: " + error.message);
    } else {
      toast.success("Configurações inicializadas com sucesso");
      qc.invalidateQueries({ queryKey: ["extraction_settings", projectId] });
    }
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">Carregando…</p>;

  if (queryError) {
    return (
      <p className="text-sm text-destructive">
        Erro ao carregar configurações: {describeError(queryError)}
      </p>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          Nenhuma configuração de extração encontrada no banco de dados.
        </p>
        <Button onClick={initializeSettings} disabled={initializing}>
          {initializing ? "Inicializando…" : "Inicializar configurações"}
        </Button>
      </div>
    );
  }

  const defs = PROVIDER_DEFAULTS[provider];

  return (
    <div className="space-y-4">
      {/* LLM Model for Extraction */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Modelo LLM (Extração)</CardTitle>
          <p className="text-xs text-muted-foreground">
            Provider e modelo usados <strong>exclusivamente</strong> para o processo de extração de dados.
            Suas credenciais ficam apenas no navegador (localStorage). Não armazenamos no servidor.
          </p>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div>
            <Label>Provider</Label>
            <select
              className="w-full rounded border bg-background p-2 text-sm"
              value={provider}
              onChange={(e) => onProviderChange(e.target.value as Provider)}
            >
              <option value="lovable">Lovable AI Gateway</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google Gemini</option>
              <option value="openrouter">OpenRouter</option>
              <option value="custom">Custom (OpenAI-compat)</option>
            </select>
          </div>
          <ModelField
            provider={provider}
            apiKey={apiKey}
            model={model}
            onChange={(m) => { setModel(m); saveLlmConfig({ model: m }); }}
          />
          <div>
            <Label>Temperature</Label>
            <Input
              type="number"
              step="0.05"
              value={llmTemperature}
              onChange={(e) => { setLlmTemperature(e.target.value); saveLlmConfig({ temperature: e.target.value }); }}
            />
          </div>
          {(defs.needsKey || provider === "custom") && (
            <div className="col-span-2">
              <Label>API Key {defs.needsKey ? "*" : "(opcional)"}</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); saveLlmConfig({ apiKey: e.target.value }); }}
                placeholder="sk-…"
              />
            </div>
          )}
          {provider === "custom" && (
            <div className="col-span-2">
              <Label>Endpoint *</Label>
              <Input
                value={endpoint}
                onChange={(e) => { setEndpoint(e.target.value); saveLlmConfig({ endpoint: e.target.value }); }}
                placeholder="https://meu-endpoint/v1/chat/completions"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pipeline params */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Parâmetros</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-3">
          <div>
            <Label>Chunk size (chars)</Label>
            <Input type="number" value={chunkSize} onChange={(e) => setChunkSize(e.target.value)} />
          </div>
          <div>
            <Label>Max chunks por execução</Label>
            <Input type="number" value={maxChunks} onChange={(e) => setMaxChunks(e.target.value)} />
          </div>
          <div>
            <Label>Temperature (fallback)</Label>
            <Input type="number" step="0.05" value={temperature} onChange={(e) => setTemperature(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">LLM usage</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="flex items-start gap-3 text-sm">
            <Switch checked={useLlmForDynamic} onCheckedChange={setUseLlmForDynamic} />
            <span>
              <span className="font-medium">Use LLM for dynamic fields and additional information</span>
              <span className="block text-xs text-muted-foreground">
                Quando desligado, a extração tenta resolver tudo via regex/keyword. A LLM só é chamada
                para data points não resolvidos cuja estratégia explicitamente exige LLM (hybrid/llm).
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Prompt de extração (unificado)</CardTitle>
          <p className="text-xs text-muted-foreground">
            Prompt único enviado à LLM para extrair os data points. Inclua tanto as instruções gerais
            (papel do agente, regras de plausibilidade, formato de saída) quanto o template por
            tópico/chunk. Variáveis disponíveis:{" "}
            <code className="font-mono">{`{{topic_slug}}`}</code>,{" "}
            <code className="font-mono">{`{{topic_name}}`}</code>,{" "}
            <code className="font-mono">{`{{topic_description}}`}</code>,{" "}
            <code className="font-mono">{`{{data_points}}`}</code>,{" "}
            <code className="font-mono">{`{{chunk}}`}</code>.
          </p>
        </CardHeader>
        <CardContent>
          <Textarea
            rows={22}
            className="font-mono text-xs"
            value={unifiedPrompt}
            onChange={(e) => setUnifiedPrompt(e.target.value)}
          />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>{saving ? "Salvando…" : "Salvar"}</Button>
      </div>
    </div>
  );
}
