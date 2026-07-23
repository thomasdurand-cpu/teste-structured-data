import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useModelOptions } from "./useModelOptions";
import type { Provider } from "@/lib/llm-provider-call";

export function ModelField({
  provider,
  apiKey,
  model,
  onChange,
}: {
  provider: Provider;
  apiKey: string;
  model: string;
  onChange: (model: string) => void;
}) {
  const { fetchable, models, isLoading, error } = useModelOptions(provider, apiKey);

  if (!fetchable) {
    return (
      <div>
        <Label>Model</Label>
        <Input value={model} onChange={(e) => onChange(e.target.value)} />
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div>
        <Label>Model</Label>
        <Input value={model} onChange={(e) => onChange(e.target.value)} />
        <p className="mt-1 text-[11px] text-muted-foreground">
          {isLoading
            ? "Carregando modelos…"
            : error
              ? `Não foi possível listar modelos (${error}). Digite o nome manualmente.`
              : "Informe a API key para carregar a lista de modelos."}
        </p>
      </div>
    );
  }

  // Keep the currently configured model selectable even if it's not in the fetched list
  // (e.g. a value saved before the dropdown existed, or one the API no longer returns).
  const options = models.some((m) => m.id === model)
    ? models
    : [{ id: model, label: model }, ...models];

  return (
    <div>
      <Label>Model</Label>
      <select
        className="w-full rounded border bg-background p-2 text-sm"
        value={model}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id}
            {m.costTier ? ` — ${m.costTier}` : ""}
          </option>
        ))}
      </select>
      {isLoading && <p className="mt-1 text-[11px] text-muted-foreground">Atualizando lista…</p>}
    </div>
  );
}
