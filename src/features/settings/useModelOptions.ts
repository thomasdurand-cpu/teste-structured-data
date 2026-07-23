import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listModels } from "@/lib/llm-providers.functions";
import type { Provider } from "@/lib/llm-provider-call";

// Providers whose model list can be fetched live from their API.
const FETCHABLE: Provider[] = ["openai", "anthropic", "google", "openrouter"];

function useDebounced<T>(value: T, delay = 500): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/** Fetches the model list for a provider once an API key is present (debounced), for the Model dropdown. */
export function useModelOptions(provider: Provider, apiKey: string) {
  const listModelsFn = useServerFn(listModels);
  const debouncedKey = useDebounced(apiKey.trim());
  const fetchable = FETCHABLE.includes(provider);
  // OpenRouter's catalog is public; the others require a key to authenticate the call.
  const canFetch = fetchable && (provider === "openrouter" || debouncedKey.length > 0);

  const { data, isFetching, error } = useQuery({
    queryKey: ["llm-models", provider, debouncedKey],
    queryFn: () => listModelsFn({ data: { provider, apiKey: debouncedKey || undefined } }),
    enabled: canFetch,
    staleTime: 5 * 60_000,
    retry: false,
  });

  return {
    fetchable,
    models: data ?? [],
    isLoading: canFetch && isFetching,
    error: canFetch && error ? (error as Error).message : null,
  };
}
