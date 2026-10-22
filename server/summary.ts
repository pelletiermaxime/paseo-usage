import {
  cacheSavingsUsd,
  createOverrideRateTable,
  lookupRate,
  priceUsage,
  type RateTable,
} from "./pricing.ts";
import { totalTokens, type UsageRecord } from "./types.ts";
import type { Totals, UsageSettings, UsageSummary } from "../shared/usage.ts";

export const emptyTotals = (): Totals => ({
  tokens: 0,
  cached: 0,
  input: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  cost: 0,
  savings: 0,
  unpriced: 0,
  inputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  outputCost: 0,
  otherCost: 0,
  standardCost: 0,
  fastCost: 0,
  ultrafastCost: 0,
  premium: 0,
});
export function summarize(
  records: UsageRecord[],
  sources: UsageSummary["sources"],
  settings: UsageSettings,
  input: { days: 1 | 7 | 30 | 90; timeZone: string; hiddenProviders: string[] },
  now = new Date(),
  rates: RateTable = new Map(),
): UsageSummary {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dayKey = (date: Date) => {
    const parts = formatter.formatToParts(date);
    return ["year", "month", "day"]
      .map((part) => parts.find((p) => p.type === part)!.value)
      .join("-");
  };
  // Calendar days for 7/30/90; a rolling 24 hours for the hourly view.
  const today = dayKey(now);
  const first = new Date(today + "T12:00:00Z");
  first.setUTCDate(first.getUTCDate() - input.days + 1);
  const firstDay = first.toISOString().slice(0, 10);
  const since = input.days === 1 ? new Date(now.getTime() - 86_400_000).toISOString() : firstDay;
  const hidden = new Set(input.hiddenProviders);
  const overrides = createOverrideRateTable(settings.prices);
  const totals = emptyTotals();
  const providers = new Map<string, Totals>();
  const sessions = new Set<string>();
  const providerSessions = new Map<string, Set<string>>();
  const modelSessions = new Map<string, Set<string>>();
  const models = new Map<
    string,
    { totals: Totals; model: string; provider: string; rateModel: string | null }
  >();
  const buckets = new Map<string, Totals & { key: string; provider: string }>();
  const modelBuckets = new Map<string, Map<string, Totals & { key: string; provider: string }>>();
  let unresolvedSpeed = 0;
  for (const original of records) {
    if (hidden.has(original.provider) || original.timestampMs > now.getTime()) continue;
    const day = dayKey(new Date(original.timestampMs));
    if (input.days === 1 ? original.timestampMs < Date.parse(since) : day < firstDay) continue;
    const mapped = settings.modelMappings[original.model]?.trim();
    const record = mapped ? { ...original, model: mapped, rateModel: mapped } : original;
    const rateModel = record.rateModel ?? record.model;
    const modelKey = record.provider + ":" + record.model;
    const hour = new Date(record.timestampMs);
    hour.setUTCMinutes(0, 0, 0);
    const key = input.days === 1 ? hour.toISOString() : day;
    const bucketId = record.provider + ":" + key;
    const priced = priceUsage(rates, record, overrides);
    if (record.unresolvedServiceTierTurnId) unresolvedSpeed++;
    const value: Totals = {
      ...emptyTotals(),
      tokens: totalTokens(record.totals),
      input: record.totals.uncachedInputTokens,
      cached: record.totals.cachedInputTokens,
      cacheWrite: record.totals.cacheCreationTokens,
      output: record.totals.outputTokens,
      reasoning: record.totals.reasoningTokens,
      cost: priced.costUsd,
      savings: cacheSavingsUsd(rates, record, overrides),
      unpriced: priced.costSource === "unpriced" ? 1 : 0,
      inputCost: priced.categoryCostUsd?.input ?? 0,
      cacheReadCost: priced.categoryCostUsd?.cacheRead ?? 0,
      cacheWriteCost: priced.categoryCostUsd?.cacheWrite ?? 0,
      outputCost: priced.categoryCostUsd?.output ?? 0,
      otherCost: priced.categoryCostUsd === null ? priced.costUsd : 0,
      standardCost: record.speed === "standard" ? priced.costUsd : 0,
      fastCost: record.speed === "fast" ? priced.costUsd : 0,
      ultrafastCost: record.speed === "ultrafast" ? priced.costUsd : 0,
      premium: priced.speedPremiumUsd,
    };
    const accumulate = (target: Totals) => {
      for (const field of Object.keys(value) as (keyof Totals)[]) target[field] += value[field];
    };
    accumulate(totals);
    if (!providers.has(record.provider)) providers.set(record.provider, emptyTotals());
    accumulate(providers.get(record.provider)!);
    if (!models.has(modelKey))
      models.set(modelKey, {
        model: record.model,
        provider: record.provider,
        rateModel,
        totals: emptyTotals(),
      });
    // A display model may combine different provider rate identities. In that
    // case there is no single catalog price to show in the model detail.
    if (models.get(modelKey)!.rateModel !== rateModel) models.get(modelKey)!.rateModel = null;
    accumulate(models.get(modelKey)!.totals);
    if (!buckets.has(bucketId))
      buckets.set(bucketId, { ...emptyTotals(), key, provider: record.provider });
    accumulate(buckets.get(bucketId)!);
    if (!modelBuckets.has(modelKey)) modelBuckets.set(modelKey, new Map());
    const byModel = modelBuckets.get(modelKey)!;
    if (!byModel.has(key)) byModel.set(key, { ...emptyTotals(), key, provider: record.provider });
    accumulate(byModel.get(key)!);
    const session = record.provider + ":" + record.sessionId;
    sessions.add(session);
    if (!providerSessions.has(record.provider)) providerSessions.set(record.provider, new Set());
    providerSessions.get(record.provider)!.add(session);
    if (!modelSessions.has(modelKey)) modelSessions.set(modelKey, new Set());
    modelSessions.get(modelKey)!.add(session);
  }
  const warnings = sources
    .filter((s) => s.status === "partial" && !hidden.has(s.provider))
    .map((s) => s.message!)
    .filter(Boolean);
  if (unresolvedSpeed)
    warnings.push(
      "Some Codex history omits its service tier. These requests use standard-rate estimates.",
    );
  if (totals.unpriced)
    warnings.push(
      `${totals.unpriced.toLocaleString()} records have no known model price and are excluded from the API estimate. Set their prices under Model prices.`,
    );
  return {
    fetchedAt: now.toISOString(),
    since,
    until: now.toISOString(),
    sessions: sessions.size,
    totals,
    providers: [...providers].map(([provider, t]) => ({
      ...t,
      provider,
      sessions: providerSessions.get(provider)!.size,
    })),
    models: [...models]
      .map(([key, entry]) => {
        const override = settings.prices[entry.model];
        const rate = entry.rateModel === null ? null : lookupRate(rates, entry.rateModel);
        return {
          ...entry.totals,
          model: entry.model,
          provider: entry.provider,
          sessions: modelSessions.get(key)!.size,
          buckets: [...modelBuckets.get(key)!.values()],
          price:
            override ??
            (rate
              ? {
                  inputCostPerMillionTokens: rate.inputCostPerToken * 1e6,
                  outputCostPerMillionTokens: rate.outputCostPerToken * 1e6,
                  cacheReadCostPerMillionTokens: rate.cacheReadCostPerToken * 1e6,
                  cacheWriteCostPerMillionTokens: rate.cacheCreationCostPerToken * 1e6,
                }
              : null),
        };
      })
      .sort((a, b) => b.cost - a.cost),
    buckets: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)),
    sources,
    warnings,
  };
}
