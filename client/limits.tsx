import { useEffect, useState } from "react";
import { usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { Button, count, Label, money, ProviderMark, styles, useColors } from "./ui";

export function resetLabel(value: string | null | undefined, now: number) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const minutes = Math.ceil((time - now) / 60_000);
  if (minutes <= 0) return "Reset due · refresh to check";
  if (minutes < 60) return "Resets in " + minutes + "m";
  if (minutes < 1440) return "Resets in " + Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
  return (
    "Resets " +
    new Date(time).toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    })
  );
}
export function Limits({
  hostId,
  hidden,
  refreshKey,
}: {
  hostId: string;
  hidden: string[];
  refreshKey: number;
}) {
  const c = useColors();
  const paseo = usePaseo();
  const [now, setNow] = useState(Date.now());
  const query = useQuery({
    queryKey: ["usage-limits", hostId, refreshKey],
    queryFn: () => paseo.providers.listUsage(),
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  if (query.isPending) return <Label muted>Checking subscription limits…</Label>;
  if (query.isError)
    return (
      <View style={{ gap: 10 }}>
        <Label>Could not load subscription limits from this host.</Label>
        <Button icon="RefreshCw" onPress={() => void query.refetch()}>
          Try again
        </Button>
      </View>
    );
  const providers = query.data.providers.filter((p) => !hidden.includes(p.providerId));
  return (
    <View style={{ gap: 28 }}>
      {providers.length === 0 && (
        <Label muted>
          No subscription limits are available. Sign in to a supported provider on this Paseo host,
          then refresh.
        </Label>
      )}
      {providers.map((provider) => (
        <View key={provider.providerId} style={{ gap: 12 }}>
          <View style={styles.between}>
            <View style={styles.row}>
              <ProviderMark provider={provider.providerId} />
              <Label style={{ fontSize: 15, fontWeight: "500" }}>{provider.displayName}</Label>
              {provider.planLabel && (
                <Label muted style={{ fontSize: 11 }}>
                  {provider.planLabel}
                </Label>
              )}
            </View>
            <Label muted style={{ fontSize: 11 }}>
              {provider.sourceLabel}
            </Label>
          </View>
          {provider.status !== "available" && (
            <View style={{ padding: 16, borderWidth: 1, borderColor: c.border, borderRadius: 8 }}>
              <Label muted>
                {provider.error ||
                  "No quota is available. Check the provider login on this host and refresh."}
              </Label>
            </View>
          )}
          <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
            {provider.windows.map((window) => {
              const remaining =
                window.remainingPct ?? (window.usedPct == null ? null : 100 - window.usedPct);
              const pct = remaining == null ? null : Math.max(0, Math.min(100, remaining));
              const color =
                pct == null
                  ? c.foregroundMuted
                  : pct < 10
                    ? c.statusDanger
                    : pct < 25
                      ? c.statusWarning
                      : c.foreground;
              return (
                <View
                  key={window.id}
                  style={{
                    flexBasis: 270,
                    flexGrow: 1,
                    gap: 12,
                    borderWidth: 1,
                    borderColor: c.border,
                    borderRadius: 8,
                    padding: 16,
                  }}
                >
                  <View style={styles.between}>
                    <Label style={{ fontWeight: "500" }}>{window.label}</Label>
                    <Label muted style={{ fontSize: 11 }}>
                      Remaining
                    </Label>
                  </View>
                  <Label
                    style={[styles.number, { fontSize: 30, lineHeight: 36, fontWeight: "600" }]}
                  >
                    {pct == null ? "—" : Math.round(pct) + "%"}
                    <Label muted style={{ fontSize: 12 }}>
                      {" "}
                      left
                    </Label>
                  </Label>
                  <View
                    accessibilityRole="progressbar"
                    accessibilityLabel={window.label}
                    accessibilityValue={
                      pct == null ? { text: "Unknown" } : { min: 0, max: 100, now: pct }
                    }
                    style={{
                      height: 8,
                      borderRadius: 3,
                      overflow: "hidden",
                      backgroundColor: c.surface2,
                    }}
                  >
                    {pct != null && (
                      <View
                        style={{
                          height: 8,
                          width: (pct + "%") as `${number}%`,
                          backgroundColor: color,
                          borderRadius: 3,
                        }}
                      />
                    )}
                  </View>
                  <Label muted style={{ fontSize: 11 }}>
                    {resetLabel(window.resetsAt, now) ?? "Reset time unavailable"}
                  </Label>
                  {window.runsOutAt && (
                    <Label muted style={{ fontSize: 11 }}>
                      Projected to run out {new Date(window.runsOutAt).toLocaleString()}
                    </Label>
                  )}
                </View>
              );
            })}
          </View>
          {provider.balances?.map((balance) => (
            <View key={balance.id} style={styles.between}>
              <Label muted>{balance.label}</Label>
              <Label>
                {balance.remaining == null
                  ? "—"
                  : balance.unit === "usd"
                    ? money(balance.remaining)
                    : count(balance.remaining) + " " + balance.unit}{" "}
                remaining
              </Label>
            </View>
          ))}
          {provider.details?.map((detail) => (
            <View key={detail.id} style={styles.between}>
              <Label muted>{detail.label}</Label>
              <Label>{detail.value}</Label>
            </View>
          ))}
          {provider.fetchedAt && (
            <Label muted style={{ fontSize: 10 }}>
              Updated {new Date(provider.fetchedAt).toLocaleString()}
            </Label>
          )}
        </View>
      ))}
    </View>
  );
}
