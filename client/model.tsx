import { View } from "react-native";
import { Modal } from "@getpaseo/plugin/client/react-native";
import type { ModelUsage } from "../shared/usage";
import { UsageChart } from "./chart";
import { Mix } from "./breakdown";
import { Button, count, Label, money, percent, ProviderMark, styles, useColors } from "./ui";

export function ModelDetail({
  model,
  keys,
  metric,
  hourly,
  onClose,
  onPrice,
}: {
  model: ModelUsage;
  keys: string[];
  metric: "cost" | "tokens";
  hourly: boolean;
  onClose: () => void;
  onPrice: () => void;
}) {
  const c = useColors();
  return (
    <Modal
      title={model.model}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Content>
        <View style={styles.between}>
          <View style={styles.row}>
            <ProviderMark provider={model.provider} />
            <Label muted>{model.sessions.toLocaleString()} sessions</Label>
          </View>
          <Button icon="SlidersHorizontal" onPress={onPrice}>
            Set price
          </Button>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 28 }}>
          {[
            ["API estimate", model.unpriced && !model.cost ? "Unpriced" : money(model.cost)],
            ["Processed tokens", count(model.tokens)],
            [
              "Cache hit rate",
              percent(
                model.input + model.cached + model.cacheWrite
                  ? model.cached / (model.input + model.cached + model.cacheWrite)
                  : 0,
              ),
            ],
            [
              "Cost / million tokens",
              model.tokens ? money((model.cost / model.tokens) * 1e6) : "—",
            ],
          ].map(([label, value]) => (
            <View key={label} style={{ gap: 4 }}>
              <Label muted style={{ fontSize: 11 }}>
                {label}
              </Label>
              <Label style={[styles.number, { fontSize: 19, fontWeight: "500" }]}>{value}</Label>
            </View>
          ))}
        </View>
        <UsageChart
          buckets={model.buckets}
          keys={keys}
          providers={[model.provider]}
          metric={metric}
          hourly={hourly}
          height={180}
        />
        <Mix totals={model} metric={metric} />
        {model.price && (
          <View style={{ borderTopWidth: 1, borderColor: c.border, paddingTop: 12, gap: 8 }}>
            <Label muted style={{ fontSize: 11 }}>
              USD per million tokens
            </Label>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 24 }}>
              {[
                ["Input", model.price.inputCostPerMillionTokens],
                ["Output", model.price.outputCostPerMillionTokens],
                [
                  "Cache read",
                  model.price.cacheReadCostPerMillionTokens ??
                    model.price.inputCostPerMillionTokens,
                ],
                [
                  "Cache write",
                  model.price.cacheWriteCostPerMillionTokens ??
                    model.price.inputCostPerMillionTokens,
                ],
              ].map(([label, value]) => (
                <View key={label} style={{ gap: 3 }}>
                  <Label muted style={{ fontSize: 11 }}>
                    {label}
                  </Label>
                  <Label>{money(Number(value))}</Label>
                </View>
              ))}
            </View>
          </View>
        )}
      </Modal.Content>
    </Modal>
  );
}
