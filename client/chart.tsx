import { useMemo, useState } from "react";
import { Image, PixelRatio, Pressable, processColor, View } from "react-native";
import type { UsageSummary } from "../shared/usage";
import { count, Label, money, providerColor, providerLabel, styles, useColors } from "./ui";

type Bucket = UsageSummary["buckets"][number];
import { chartScale, pngDataUri, renderChartPng, type ChartSeries } from "./chart-image";

type Column = { key: string; values: number[]; total: number };
export function UsageChart({
  buckets,
  keys,
  providers,
  metric,
  hourly,
  height = 210,
}: {
  buckets: Bucket[];
  keys: string[];
  providers: string[];
  metric: "cost" | "tokens";
  hourly: boolean;
  height?: number;
}) {
  const c = useColors();
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const format = metric === "cost" ? money : count;
  const columns = useMemo<Column[]>(() => {
    const lookup = new Map(buckets.map((b) => [b.key + ":" + b.provider, b[metric]]));
    return keys.map((key) => {
      const values = providers.map((provider) => lookup.get(key + ":" + provider) ?? 0);
      return { key, values, total: values.reduce((a, b) => a + b, 0) };
    });
  }, [buckets, keys, providers, metric]);
  const series = useMemo<ChartSeries[]>(
    () =>
      providers.map((provider, i) => {
        const color = processColor(providerColor(provider, c.foreground));
        const rgba = typeof color === "number" ? color : 0xffededee;
        return {
          values: columns.map((column) => column.values[i]),
          color: [(rgba >>> 16) & 255, (rgba >>> 8) & 255, rgba & 255],
        };
      }),
    [columns, providers, c.foreground],
  );
  const { max, ticks } = useMemo(() => chartScale(series), [series]);
  const plotWidth = Math.max(1, width - 50),
    top = 14,
    plotHeight = height - 44;
  const image = useMemo(
    () =>
      pngDataUri(renderChartPng(plotWidth, plotHeight, series, max, Math.max(2, PixelRatio.get()))),
    [plotWidth, plotHeight, series, max],
  );
  const selected = hover === null ? undefined : columns[hover];
  const dateLabel = (key: string) =>
    new Date(key.length === 10 ? key + "T12:00:00Z" : key).toLocaleString(
      undefined,
      hourly ? { hour: "numeric" } : { month: "short", day: "numeric", timeZone: "UTC" },
    );
  return (
    <View style={{ gap: 8 }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <View
        style={{ height, position: "relative" }}
        accessibilityLabel={hourly ? "Hourly usage chart" : "Daily usage chart"}
      >
        {ticks.map((tick) => (
          <View
            key={tick}
            pointerEvents="none"
            style={{
              position: "absolute",
              top: top + plotHeight * (1 - tick / max),
              left: 0,
              right: 0,
            }}
          >
            <Label
              muted
              style={{ fontSize: 10, lineHeight: 12, position: "absolute", top: -6, width: 45 }}
            >
              {format(tick)}
            </Label>
            <View
              style={{ marginLeft: 50, borderTopWidth: 1, borderColor: c.border, opacity: 0.35 }}
            />
          </View>
        ))}
        <Image
          accessible={false}
          source={{ uri: image }}
          resizeMode="stretch"
          style={{ position: "absolute", left: 50, top, width: plotWidth, height: plotHeight }}
        />
        {columns.map((column, i) => (
          <Pressable
            key={column.key}
            accessibilityRole="button"
            accessibilityLabel={dateLabel(column.key) + ": " + format(column.total)}
            onHoverIn={() => setHover(i)}
            onHoverOut={() => setHover(null)}
            onPress={() => setHover(hover === i ? null : i)}
            style={{
              position: "absolute",
              left:
                50 +
                (columns.length < 2
                  ? 0
                  : Math.max(0, (i - 0.5) / (columns.length - 1)) * plotWidth),
              top,
              height: plotHeight,
              width:
                columns.length < 2
                  ? plotWidth
                  : (plotWidth / (columns.length - 1)) *
                    (i === 0 || i === columns.length - 1 ? 0.5 : 1),
            }}
          />
        ))}
        {selected && hover !== null && (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top,
              left: 50 + (hover / Math.max(1, columns.length - 1)) * plotWidth,
              height: plotHeight,
              borderLeftWidth: 1,
              borderColor: c.foregroundMuted,
              opacity: 0.7,
            }}
          />
        )}
        <View
          style={{
            position: "absolute",
            left: 50,
            right: 0,
            bottom: 0,
            flexDirection: "row",
            justifyContent: "space-between",
          }}
        >
          {keys
            .filter(
              (_, i) =>
                i === 0 ||
                i === keys.length - 1 ||
                i % Math.max(1, Math.floor(keys.length / 4)) === 0,
            )
            .map((key) => (
              <Label key={key} muted style={{ fontSize: 10 }}>
                {dateLabel(key)}
              </Label>
            ))}
        </View>
      </View>
      <View
        style={[styles.row, { flexWrap: "wrap", minHeight: 24, justifyContent: "center", gap: 16 }]}
      >
        {selected ? (
          <Label muted style={{ fontSize: 11 }}>
            {dateLabel(selected.key)} · {format(selected.total)}
          </Label>
        ) : null}
        {providers.map((p, i) => (
          <View key={p} style={styles.row}>
            <View
              style={{
                width: 7,
                height: 7,
                borderRadius: 4,
                backgroundColor: providerColor(p, c.foreground),
              }}
            />
            <Label muted style={{ fontSize: 11 }}>
              {providerLabel(p)}
              {selected ? " " + format(selected.values[i]) : ""}
            </Label>
          </View>
        ))}
      </View>
    </View>
  );
}
