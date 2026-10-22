import { summarize } from "../server/summary";
import { parseRateTable } from "../server/pricing";
import type { UsageRecord } from "../server/types";
import type { UsageSettings } from "../shared/usage";

// Entirely synthetic data for shareable screenshots. No provider readers or network requests.
export const demoMode = new URLSearchParams(window.location.search).get("demo") === "1";
const now = new Date(2026, 9, 21, 15, 33);
const models = [
  { provider: "codex", model: "gpt-5", input: 1.25, output: 10, cache: 0.125, scale: 1.3 },
  { provider: "claude", model: "claude-sonnet-4-5", input: 3, output: 15, cache: 0.3, scale: 0.8 },
  { provider: "codex", model: "gpt-5-mini", input: 0.25, output: 2, cache: 0.025, scale: 0.6 },
  { provider: "claude", model: "claude-opus-4-1", input: 15, output: 75, cache: 1.5, scale: 0.12 },
  {
    provider: "opencode",
    model: "gemini-2.5-pro",
    input: 1.25,
    output: 10,
    cache: 0.125,
    scale: 0.45,
  },
];
const rates = parseRateTable(
  Object.fromEntries(
    models.map((m) => [
      m.model,
      {
        input_cost_per_token: m.input / 1e6,
        output_cost_per_token: m.output / 1e6,
        cache_read_input_token_cost: m.cache / 1e6,
        cache_creation_input_token_cost: (m.input * 1.25) / 1e6,
      },
    ]),
  ),
);
const records: UsageRecord[] = [];
for (let day = 0; day < 30; day++) {
  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    for (let session = 0; session < 3; session++) {
      const timestamp = new Date(now);
      timestamp.setDate(timestamp.getDate() - day);
      timestamp.setHours(8 + session * 3, 12 + index * 4, 0, 0);
      const activity = [0.8, 1.2, 0.5, 1.45, 0.7, 0.35, 1.1][day % 7];
      const scale = model.scale * activity * (0.75 + session * 0.25);
      records.push({
        provider: model.provider,
        model: model.model,
        timestampMs: timestamp.getTime(),
        sessionId: `demo-${day}-${index}-${session}`,
        speed: "standard",
        reportedCostUsd: null,
        dedupeKey: null,
        totals: {
          uncachedInputTokens: Math.round(52_000 * scale),
          cachedInputTokens: Math.round(148_000 * scale),
          cacheCreationTokens: model.provider === "claude" ? Math.round(14_000 * scale) : 0,
          outputTokens: Math.round(18_000 * scale),
          reasoningTokens: model.provider === "codex" ? Math.round(6_000 * scale) : 0,
        },
      });
    }
  }
}

export function demoSummary(input: Parameters<typeof summarize>[3], settings: UsageSettings) {
  return summarize(records, [], settings, input, now, rates);
}

export const demoLimits = {
  fetchedAt: now.toISOString(),
  providers: [
    {
      providerId: "codex",
      displayName: "Codex",
      planLabel: "Demo plan",
      sourceLabel: "Demo account",
      status: "available",
      fetchedAt: now.toISOString(),
      windows: [
        { id: "session", label: "Session", remainingPct: 72, resetsAt: null },
        { id: "weekly", label: "Weekly", remainingPct: 58, resetsAt: null },
      ],
    },
    {
      providerId: "claude",
      displayName: "Claude Code",
      planLabel: "Demo plan",
      sourceLabel: "Demo account",
      status: "available",
      fetchedAt: now.toISOString(),
      windows: [
        { id: "session", label: "Session", remainingPct: 84, resetsAt: null },
        { id: "weekly", label: "Weekly", remainingPct: 41, resetsAt: null },
      ],
    },
  ],
};
