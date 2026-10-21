import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const historyProviders = [
  "codex",
  "claude",
  "grok",
  "opencode",
  "antigravity",
  "pi",
  "cursor",
] as const;

const rate = z.number().finite().nonnegative().max(1_000_000);
export const priceSchema = z.object({
  inputCostPerMillionTokens: rate,
  outputCostPerMillionTokens: rate,
  cacheReadCostPerMillionTokens: rate.optional(),
  cacheWriteCostPerMillionTokens: rate.optional(),
});
export const usageSettings = defineSettings({
  id: "usage",
  scope: "host",
  version: 1,
  schema: z.object({
    metric: z.enum(["cost", "tokens", "limits"]).default("cost"),
    days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]).default(7),
    hiddenProviders: z.array(z.string()).default([]),
    codexHomes: z.array(z.string()).default([]),
    claudeHomes: z.array(z.string()).default([]),
    grokHomes: z.array(z.string()).default([]),
    piSessionDirs: z.array(z.string()).default([]),
    opencodeDataDirs: z.array(z.string()).default([]),
    antigravityDataDirs: z.array(z.string()).default([]),
    cursorAuthFiles: z.array(z.string()).default([]),
    cursorKeychainEnabled: z.boolean().default(false),
    prices: z.record(z.string(), priceSchema).default({}),
    modelMappings: z.record(z.string(), z.string()).default({}),
  }),
});
export type UsageSettings = z.infer<typeof usageSettings.schema>;
export const totalsSchema = z.object({
  tokens: z.number(),
  cached: z.number(),
  input: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cost: z.number(),
  savings: z.number(),
  unpriced: z.number(),
  inputCost: z.number(),
  cacheReadCost: z.number(),
  cacheWriteCost: z.number(),
  outputCost: z.number(),
  otherCost: z.number(),
  standardCost: z.number(),
  fastCost: z.number(),
  ultrafastCost: z.number(),
  premium: z.number(),
});
export type Totals = z.infer<typeof totalsSchema>;
const bucketSchema = totalsSchema.extend({ key: z.string(), provider: z.string() });
const modelSchema = totalsSchema.extend({
  model: z.string(),
  provider: z.string(),
  sessions: z.number(),
  buckets: z.array(bucketSchema),
  price: priceSchema.nullable(),
});
export type ModelUsage = z.infer<typeof modelSchema>;
export const summaryRpc = defineRpc({
  name: "usage.summary",
  input: z.object({
    days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]),
    timeZone: z.string().max(100),
    hiddenProviders: z.array(z.string()),
    refresh: z.boolean().default(false),
  }),
  output: z.object({
    fetchedAt: z.string(),
    pricingUpdatedAt: z.string().optional(),
    since: z.string(),
    until: z.string(),
    sessions: z.number(),
    totals: totalsSchema,
    providers: z.array(totalsSchema.extend({ provider: z.string(), sessions: z.number() })),
    models: z.array(modelSchema),
    buckets: z.array(bucketSchema),
    sources: z.array(
      z.object({
        provider: z.string(),
        files: z.number(),
        records: z.number(),
        status: z.enum(["ready", "missing", "partial"]),
        message: z.string().optional(),
      }),
    ),
    warnings: z.array(z.string()),
  }),
});
export type UsageSummary = z.infer<typeof summaryRpc.output>;
