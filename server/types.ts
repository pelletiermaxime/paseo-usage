export interface UsageTokenTotals {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}
export type UsageSpeed = "standard" | "fast" | "ultrafast";
export interface UsageRecord {
  provider: string;
  timestampMs: number;
  model: string;
  rateModel?: string;
  sessionId: string;
  totals: UsageTokenTotals;
  reportedCostUsd: number | null;
  speed: UsageSpeed;
  dedupeKey: string | null;
  unresolvedServiceTierTurnId?: string;
}
export interface UsageCategoryCost {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
export type UsageCostSource = "unpriced" | "providerReported" | "modelPriced";
export interface UsageModelPriceOverride {
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
  cacheReadCostPerMillionTokens?: number;
  cacheWriteCostPerMillionTokens?: number;
}
export const tokenCount = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
export function parseTimestampMs(value: unknown): number | null {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}
export const totalTokens = (t: UsageTokenTotals) =>
  t.uncachedInputTokens + t.cachedInputTokens + t.cacheCreationTokens + t.outputTokens;
