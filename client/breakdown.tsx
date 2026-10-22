import { useState } from "react";
import { Pressable, View, type TextStyle } from "react-native";
import type { ModelUsage, Totals, UsageSummary } from "../shared/usage";
import {
  count,
  costLabel,
  Label,
  money,
  percent,
  providerColor,
  providerLabel,
  ProviderMark,
  Section,
  Segments,
  styles,
  useColors,
} from "./ui";

export function ShareBar({
  title,
  segments,
  format = money,
}: {
  title: string;
  segments: { label: string; value: number; color: string }[];
  format?: (n: number) => string;
}) {
  const total = segments.reduce((sum, entry) => sum + entry.value, 0);
  return (
    <Section title={title}>
      <View
        style={{ flexDirection: "row", height: 8, borderRadius: 3, overflow: "hidden", gap: 2 }}
      >
        {segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <View
              key={s.label}
              style={{ flex: s.value, backgroundColor: s.color }}
              accessibilityLabel={s.label + ": " + format(s.value)}
            />
          ))}
      </View>
      <View style={{ flexDirection: "row", gap: 22, flexWrap: "wrap" }}>
        {segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <View key={s.label} style={{ gap: 3 }}>
              <View style={styles.row}>
                <View style={{ backgroundColor: s.color, width: 7, height: 7, borderRadius: 3 }} />
                <Label muted style={{ fontSize: 11 }}>
                  {s.label}
                </Label>
              </View>
              <Label style={[styles.number, { fontSize: 12 }]}>
                {format(s.value)}{" "}
                <Label muted style={{ fontSize: 10 }}>
                  {percent(total ? s.value / total : 0)}
                </Label>
              </Label>
            </View>
          ))}
      </View>
    </Section>
  );
}
export function Mix({ totals: t, metric }: { totals: Totals; metric: "cost" | "tokens" }) {
  const c = useColors();
  return (
    <View style={{ gap: 24 }}>
      <ShareBar
        title={metric === "cost" ? "Cost by type" : "Tokens by type"}
        format={metric === "cost" ? money : count}
        segments={[
          {
            label: "Uncached input",
            value: metric === "cost" ? t.inputCost : t.input,
            color: "#5b9bbd",
          },
          {
            label: "Cache read",
            value: metric === "cost" ? t.cacheReadCost : t.cached,
            color: "#4d9f8a",
          },
          {
            label: "Cache write",
            value: metric === "cost" ? t.cacheWriteCost : t.cacheWrite,
            color: "#b49b62",
          },
          { label: "Output", value: metric === "cost" ? t.outputCost : t.output, color: "#8c7bd1" },
          { label: "Other", value: metric === "cost" ? t.otherCost : 0, color: c.foregroundMuted },
        ]}
      />
      {metric === "cost" && t.fastCost + t.ultrafastCost > 0 && (
        <ShareBar
          title={"Cost by speed · " + money(t.premium) + " premium"}
          segments={[
            { label: "Standard", value: t.standardCost, color: c.foreground },
            { label: "Fast", value: t.fastCost, color: "#5b9bbd" },
            { label: "Ultrafast", value: t.ultrafastCost, color: "#8c7bd1" },
          ]}
        />
      )}
    </View>
  );
}
export function Breakdown({
  summary,
  metric,
  hourly,
  compact,
  onSelect,
}: {
  summary: UsageSummary;
  metric: "cost" | "tokens";
  hourly: boolean;
  compact: boolean;
  onSelect: (model: ModelUsage) => void;
}) {
  const c = useColors();
  const [mode, setMode] = useState<"model" | "time">("model");
  const models = [...summary.models].sort((a, b) => b[metric] - a[metric]);
  const peak = Math.max(0, ...models.map((m) => m[metric]));
  const periods = [...new Set(summary.buckets.map((b) => b.key))].sort().reverse();
  const numericWidth = compact ? 65 : 94;
  const row = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    borderBottomWidth: 1,
    borderColor: c.border,
    paddingVertical: 11,
    gap: compact ? 10 : 24,
  };
  const cell: TextStyle = {
    width: numericWidth,
    textAlign: "right" as const,
    fontVariant: ["tabular-nums"],
  };
  const heading = { fontSize: 11, color: c.foregroundMuted };
  return (
    <Section
      title="Breakdown"
      trailing={
        <Segments
          label="Usage breakdown"
          options={[
            { value: "model", label: "Model" },
            { value: "time", label: hourly ? "Hour" : "Day" },
          ]}
          value={mode}
          onChange={setMode}
        />
      }
    >
      <View>
        <View style={row}>
          {mode === "model" && (
            <Label muted style={{ width: 16, fontSize: 11 }}>
              #
            </Label>
          )}
          <Label style={[heading, { flex: 1 }]}>
            {mode === "model" ? "Model" : hourly ? "Hour" : "Day"}
          </Label>
          <Label style={[heading, cell]}>Cost</Label>
          {!compact && <Label style={[heading, cell]}>Share</Label>}
          <Label style={[heading, cell]}>Tokens</Label>
        </View>
        {mode === "model"
          ? models.map((model, i) => (
              <Pressable
                key={model.provider + ":" + model.model}
                accessibilityRole="button"
                accessibilityLabel={"Usage for " + model.model}
                onPress={() => onSelect(model)}
                style={({ pressed }) => [row, pressed && { backgroundColor: c.surface1 }]}
              >
                <Label muted style={{ width: 16, fontSize: 11 }}>
                  {i + 1}
                </Label>
                <View style={{ flex: 1, gap: 6 }}>
                  <View style={styles.row}>
                    <ProviderMark provider={model.provider} small />
                    <Label style={{ flex: 1, fontSize: 12 }}>{model.model}</Label>
                  </View>
                  {peak > 0 && (
                    <View style={{ maxWidth: 192, height: 2 }}>
                      <View
                        style={{
                          height: 2,
                          width: (Math.max(1, (model[metric] / peak) * 100) + "%") as `${number}%`,
                          borderRadius: 2,
                          backgroundColor: providerColor(model.provider, c.foreground),
                        }}
                      />
                    </View>
                  )}
                </View>
                <Label style={cell}>{costLabel(model)}</Label>
                {!compact && (
                  <Label muted style={cell}>
                    {percent(
                      summary.totals[metric] > 0 ? model[metric] / summary.totals[metric] : 0,
                    )}
                  </Label>
                )}
                <Label muted style={cell}>
                  {count(model.tokens)}
                </Label>
              </Pressable>
            ))
          : periods.map((key) => {
              const rows = summary.buckets.filter((b) => b.key === key);
              const cost = rows.reduce((sum, b) => sum + b.cost, 0),
                unpriced = rows.reduce((sum, b) => sum + b.unpriced, 0),
                tokens = rows.reduce((sum, b) => sum + b.tokens, 0);
              const value = metric === "cost" ? cost : tokens;
              return (
                <View key={key} style={row}>
                  <View style={{ flex: 1 }}>
                    <Label>
                      {new Date(key.length === 10 ? key + "T12:00:00Z" : key).toLocaleString(
                        undefined,
                        hourly
                          ? { month: "short", day: "numeric", hour: "numeric" }
                          : { month: "short", day: "numeric", timeZone: "UTC" },
                      )}
                    </Label>
                    {!compact && (
                      <Label muted style={{ fontSize: 10 }}>
                        {rows
                          .map(
                            (b) =>
                              providerLabel(b.provider) +
                              " " +
                              (metric === "cost" ? costLabel(b) : count(b.tokens)),
                          )
                          .join(" · ")}
                      </Label>
                    )}
                  </View>
                  <Label style={cell}>{costLabel({ cost, unpriced })}</Label>
                  {!compact && (
                    <Label muted style={cell}>
                      {percent(summary.totals[metric] ? value / summary.totals[metric] : 0)}
                    </Label>
                  )}
                  <Label muted style={cell}>
                    {count(tokens)}
                  </Label>
                </View>
              );
            })}
        {(mode === "model" ? models : periods).length === 0 && (
          <View style={{ padding: 24, alignItems: "center" }}>
            <Label muted>No activity in this window.</Label>
          </View>
        )}
      </View>
    </Section>
  );
}
