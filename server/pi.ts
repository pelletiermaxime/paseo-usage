// Adapted from T3 Code (MIT). See ../THIRD_PARTY_NOTICES.md.
import { z } from "zod";
import { parseTimestampMs, tokenCount, totalTokens, type UsageRecord } from "./types";

const usage = z.object({
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  cacheRead: z.unknown().optional(),
  cacheWrite: z.unknown().optional(),
  reasoning: z.unknown().optional(),
  cost: z.object({ total: z.unknown() }).optional(),
});
const identity = { id: z.string().min(1), timestamp: z.string() };
const model = { provider: z.string().min(1), model: z.string().min(1) };
const entrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), id: z.string().min(1) }),
  z.object({
    ...identity,
    type: z.literal("message"),
    message: z.discriminatedUnion("role", [
      z.object({
        ...model,
        role: z.literal("assistant"),
        responseModel: z.string().min(1).optional(),
        usage,
      }),
      z.object({ role: z.literal("toolResult"), usage }),
    ]),
  }),
  z.object({ ...identity, ...model, type: z.literal("usage"), usage }),
  z.object({ ...identity, type: z.enum(["compaction", "branch_summary"]), usage }),
]);

export function parsePiLine(line: string, state: { sessionId: string }): UsageRecord[] {
  const decoded = entrySchema.safeParse(JSON.parse(line));
  if (!decoded.success) return [];
  const entry = decoded.data;
  if (entry.type === "session") {
    state.sessionId = entry.id;
    return [];
  }
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const source = entry.type === "message" ? entry.message : entry;
  const rateModel =
    "model" in source
      ? "responseModel" in source
        ? (source.responseModel ?? source.model)
        : source.model
      : undefined;
  const name = "provider" in source ? `${source.provider}/${rateModel}` : "Tools/summaries";
  const outputTokens = tokenCount(source.usage.output);
  const totals = {
    uncachedInputTokens: tokenCount(source.usage.input),
    cachedInputTokens: tokenCount(source.usage.cacheRead),
    cacheCreationTokens: tokenCount(source.usage.cacheWrite),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(source.usage.reasoning)),
  };
  const cost = source.usage.cost?.total;
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
  return [
    {
      provider: "pi",
      timestampMs,
      model: name,
      rateModel,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      dedupeKey: JSON.stringify(["pi", entry.id, entry.timestamp, name]),
    },
  ];
}
