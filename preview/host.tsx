import { useCallback, useState } from "react";
import { summaryRpc, usageSettings, type UsageSettings } from "../shared/usage";
import { demoLimits, demoMode, demoSummary } from "./demo";
export const previewSettings = { current: usageSettings.schema.parse({}) };
export function useSettings() {
  const [values, setValues] = useState(previewSettings.current);
  return {
    status: "ready" as const,
    values,
    revision: "preview",
    saving: false,
    saveError: null,
    save: async (next: UsageSettings) => {
      previewSettings.current = usageSettings.schema.parse(next);
      setValues(previewSettings.current);
      return true;
    },
    reset: async () => {
      const next = usageSettings.schema.parse({});
      previewSettings.current = next;
      setValues(next);
      return true;
    },
    reload: async () => {},
  };
}
export function useRpc() {
  return useCallback(async (input: unknown) => {
    if (demoMode) return demoSummary(summaryRpc.input.parse(input), previewSettings.current);
    const response = await fetch("/api/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, settings: previewSettings.current }),
    });
    if (!response.ok) throw new Error("Preview history could not be read.");
    return response.json();
  }, []);
}
export function usePaseo() {
  return {
    providers: {
      listUsage: async () =>
        demoMode ? demoLimits : { fetchedAt: new Date().toISOString(), providers: [] },
    },
  };
}
