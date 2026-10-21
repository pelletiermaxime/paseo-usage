import { expect, test } from "vite-plus/test";
import { summarize } from "../server/summary";
import { createOverrideRateTable, priceUsage } from "../server/pricing";
import type { UsageRecord } from "../server/types";
import { summaryRpc, usageSettings } from "../shared/usage";

const now = new Date("2026-10-21T02:30:00Z");
const settings = usageSettings.schema.parse({
  prices: {
    model: {
      inputCostPerMillionTokens: 10,
      outputCostPerMillionTokens: 20,
      cacheReadCostPerMillionTokens: 1,
    },
  },
});
const input = { days: 7 as const, timeZone: "America/Toronto", hiddenProviders: [] };
const record = (patch: Partial<UsageRecord> = {}): UsageRecord => ({
  provider: "codex",
  timestampMs: Date.parse("2026-10-20T22:00:00Z"),
  model: "model",
  sessionId: "session",
  speed: "standard",
  reportedCostUsd: null,
  dedupeKey: null,
  totals: {
    uncachedInputTokens: 100,
    cachedInputTokens: 200,
    cacheCreationTokens: 30,
    outputTokens: 50,
    reasoningTokens: 20,
  },
  ...patch,
});
test("totals, buckets and models agree; reasoning is inside output and cache writes use input when unspecified", () => {
  const result = summarize(
    [record(), record({ provider: "claude", sessionId: "second" })],
    [],
    settings,
    input,
    now,
  );
  expect(result.sessions).toBe(2);
  expect(result.totals.tokens).toBe(760);
  expect(result.totals.cost).toBeCloseTo(0.005);
  expect(result.totals.savings).toBeCloseTo(0.0036);
  expect(result.models.reduce((sum, m) => sum + m.cost, 0)).toBeCloseTo(result.totals.cost);
  expect(result.buckets[0].key).toBe("2026-10-20");
  expect(summaryRpc.output.safeParse(result).success).toBe(true);
});
test("calendar filtering uses the client timezone, and Past 24h is a rolling window", () => {
  const rows = [
    record({ timestampMs: Date.parse("2026-10-14T03:59:00Z") }),
    record({ timestampMs: Date.parse("2026-10-14T04:00:00Z") }),
    record({ timestampMs: now.getTime() + 1 }),
  ];
  expect(summarize(rows, [], settings, input, now).totals.tokens).toBe(380);
  const recent = [
    record({ timestampMs: now.getTime() - 86_400_001 }),
    record({ timestampMs: now.getTime() - 86_400_000 }),
  ];
  const result = summarize(recent, [], settings, { ...input, days: 1 }, now);
  expect(result.totals.tokens).toBe(380);
  expect(result.buckets[0].key).toBe("2026-10-20T02:00:00.000Z");
});
test("provider filters, unknown pricing, model mappings, and zero overrides preserve attribution", () => {
  const rows = [record(), record({ provider: "claude" }), record({ model: "unknown" })];
  const hidden = summarize(rows, [], settings, { ...input, hiddenProviders: ["claude"] }, now);
  expect(hidden.sessions).toBe(1);
  expect(hidden.totals.unpriced).toBe(1);
  expect(hidden.models.find((m) => m.model === "unknown")?.price).toBeNull();
  const mapped = summarize(
    rows,
    [],
    { ...settings, modelMappings: { unknown: "model" } },
    input,
    now,
  );
  expect(mapped.models).toHaveLength(2);
  expect(mapped.totals.unpriced).toBe(0);
  const free = {
    ...settings,
    prices: { model: { inputCostPerMillionTokens: 0, outputCostPerMillionTokens: 0 } },
  };
  expect(summarize([record()], [], free, input, now).totals.cost).toBe(0);
});
test("provider-reported cost is counted as Other without rates and overrides take precedence", () => {
  const r = record({ reportedCostUsd: 7 });
  const table = new Map();
  expect(priceUsage(table, r).costUsd).toBe(7);
  expect(priceUsage(table, r).categoryCostUsd).toBeNull();
  const override = createOverrideRateTable(settings.prices);
  expect(priceUsage(table, r, override).costUsd).toBeCloseTo(0.0025);
});

test("without downloaded prices token usage stays visible and automatic costs are marked unpriced", () => {
  const defaults = usageSettings.schema.parse({});
  const result = summarize([record({ model: "gpt-5" })], [], defaults, input, now);
  expect(result.totals.tokens).toBe(380);
  expect(result.totals.unpriced).toBe(1);
  expect(result.models[0].price).toBeNull();
  expect(result.warnings).toEqual(
    expect.arrayContaining([expect.stringContaining("no known model price")]),
  );
  const reported = summarize(
    [record({ model: "gpt-5", reportedCostUsd: 7 })],
    [],
    defaults,
    input,
    now,
  );
  expect(reported.totals.unpriced).toBe(0);
  expect(reported.totals.cost).toBe(7);
});
