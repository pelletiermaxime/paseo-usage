import { useEffect, useState } from "react";
import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollView, View } from "react-native";
import {
  summaryRpc,
  usageSettings,
  historyProviders,
  type ModelUsage,
  type UsageSettings,
  type UsageSummary,
} from "../shared/usage";
import { Breakdown, Mix } from "./breakdown";
import { UsageChart } from "./chart";
import { periodKeys } from "./chart-data";
import { Limits } from "./limits";
import { ModelDetail } from "./model";
import { PriceEditor, SourceEditor } from "./settings";
import {
  Button,
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
  Theme,
  useColors,
} from "./ui";

type Metric = UsageSettings["metric"];
const metrics = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "limits", label: "Limits" },
] as const;
const periods = [
  { value: 1, label: "Past 24h" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
] as const;
export function UsageScreen(props: PluginSurfaceProps) {
  const settings = useSettings(usageSettings);
  return (
    <Theme.Provider value={props.theme}>
      {settings.status === "ready" ? (
        <ReadyUsage key={props.host.id} {...props} settings={settings} />
      ) : (
        <View
          style={{ flex: 1, padding: 24, gap: 12, backgroundColor: props.theme.colors.surface0 }}
        >
          <Label muted>{settings.status === "loading" ? "Loading Usage…" : settings.error}</Label>
          {settings.status !== "loading" && (
            <Button onPress={() => void settings.reload()}>Reload settings</Button>
          )}
          {settings.status === "invalid" && (
            <Button onPress={() => void settings.reset()}>Reset Usage settings</Button>
          )}
        </View>
      )}
    </Theme.Provider>
  );
}
type ReadySettings = Extract<SettingsState<typeof usageSettings.schema>, { status: "ready" }>;
function ReadyUsage({ host, layout, settings }: PluginSurfaceProps & { settings: ReadySettings }) {
  const c = useColors();
  const queryClient = useQueryClient();
  const rpc = useRpc(summaryRpc);
  const values = settings.values;
  const { metric, days } = values;
  const [width, setWidth] = useState(layout.compact ? 380 : 1200);
  const compact = layout.compact || width < 780;
  const [filter, setFilter] = useState<"providers" | "host" | null>(null);
  const [editor, setEditor] = useState<"prices" | "sources" | null>(null);
  const [model, setModel] = useState<ModelUsage | null>(null);
  const [priceModel, setPriceModel] = useState<string | undefined>();
  const [limitProviders, setLimitProviders] = useState<string[]>([]);
  const limitsFetching = useIsFetching({ queryKey: ["usage-limits", host.id] }) > 0;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const historyKey = [
    "usage-summary",
    host.id,
    days,
    timeZone,
    values.hiddenProviders,
    values.prices,
    values.modelMappings,
    values.codexHomes,
    values.claudeHomes,
    values.grokHomes,
    values.piSessionDirs,
    values.opencodeDataDirs,
    values.antigravityDataDirs,
    values.cursorAuthFiles,
    values.cursorKeychainEnabled,
  ];
  const query = useQuery({
    queryKey: historyKey,
    queryFn: () => rpc({ days, timeZone, hiddenProviders: values.hiddenProviders, refresh: false }),
    enabled: metric !== "limits",
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  async function refresh() {
    if (refreshing) return;
    if (metric === "limits") {
      await queryClient.invalidateQueries({ queryKey: ["usage-limits", host.id] });
      return;
    }
    setRefreshing(true);
    setRefreshError(false);
    try {
      const data = await rpc({
        days,
        timeZone,
        hiddenProviders: values.hiddenProviders,
        refresh: true,
      });
      queryClient.setQueryData(historyKey, data);
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshing(false);
    }
  }
  const save = async (patch: Partial<UsageSettings>) => {
    if (settings.saving) return false;
    return settings.save({ ...values, ...patch }, settings.revision);
  };
  const selectMetric = (next: Metric) => {
    if (next !== metric) void save({ metric: next });
  };
  const selectPeriod = (next: 1 | 7 | 30 | 90) => {
    if (next !== days) void save({ days: next });
  };
  useEffect(() => {
    // Paseo also runs on native platforms, where there is no browser event target.
    if (layout.platform !== "web") return;
    type KeyEvent = {
      key: string;
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
      repeat: boolean;
      defaultPrevented: boolean;
      preventDefault: () => void;
      target?: {
        tagName?: string;
        isContentEditable?: boolean;
        closest?: (selector: string) => unknown;
      };
    };
    const target = globalThis as unknown as {
      addEventListener?: (type: string, handler: (e: KeyEvent) => void) => void;
      removeEventListener?: (type: string, handler: (e: KeyEvent) => void) => void;
    };
    const handler = (event: KeyEvent) => {
      if (editor || model || filter || settings.saving || event.repeat || event.defaultPrevented)
        return;
      if (
        event.target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName ?? "") ||
        event.target?.closest?.('[role="dialog"], [aria-modal="true"]')
      )
        return;
      const next = ({ c: "cost", t: "tokens", l: "limits" } as const)[
        event.key.toLowerCase() as "c" | "t" | "l"
      ];
      if (next && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        selectMetric(next);
      }
      const period = ({ "1": 1, "2": 7, "3": 30, "4": 90 } as const)[
        event.key as "1" | "2" | "3" | "4"
      ];
      if (period && metric !== "limits" && (event.ctrlKey || event.metaKey) && event.shiftKey) {
        event.preventDefault();
        selectPeriod(period);
      }
    };
    target.addEventListener?.("keydown", handler);
    return () => target.removeEventListener?.("keydown", handler);
  });
  const summary = query.data;
  const keys = summary ? periodKeys(summary.since, summary.until, days === 1, timeZone) : [];
  const windowLabel = summary
    ? [
        new Date(
          summary.since.length === 10 ? summary.since + "T12:00:00Z" : summary.since,
        ).toLocaleString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          timeZone: summary.since.length === 10 ? "UTC" : timeZone,
          ...(days === 1 ? ({ hour: "numeric", minute: "2-digit" } as const) : {}),
        }),
        new Date(summary.until).toLocaleString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          timeZone,
          ...(days === 1 ? ({ hour: "numeric", minute: "2-digit" } as const) : {}),
        }),
      ].join(" – ")
    : null;
  const knownProviders = [
    ...new Set([
      ...historyProviders,
      ...limitProviders,
      ...values.hiddenProviders,
      ...(summary?.providers.map((p) => p.provider) ?? []),
    ]),
  ];
  const providerText =
    values.hiddenProviders.length === 0
      ? "All providers"
      : knownProviders
          .filter((p) => !values.hiddenProviders.includes(p))
          .map(providerLabel)
          .join(", ") || "No providers";
  const openPrices = (name?: string) => {
    setPriceModel(name);
    setEditor("prices");
    setFilter(null);
  };
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, backgroundColor: c.surface0 }}
    >
      <View
        style={{
          borderBottomWidth: 1,
          borderColor: c.border,
          paddingHorizontal: compact ? 12 : 24,
          paddingVertical: 10,
          gap: 10,
        }}
      >
        <View style={[styles.between, { flexWrap: "wrap" }]}>
          <View style={[styles.row, { flexWrap: "wrap", gap: 2 }]}>
            <Label style={{ fontSize: 14, fontWeight: "500", paddingRight: 10 }}>Usage</Label>
            <Label muted>›</Label>
            <Button icon="ChevronDown" onPress={() => setFilter("host")}>
              {host.label}
            </Button>
            <Label muted>›</Label>
            <Button icon="ChevronDown" onPress={() => setFilter("providers")}>
              {providerText}
            </Button>
          </View>
          <View style={[styles.row, { flexWrap: "wrap" }]}>
            <Segments
              label="Usage metric"
              options={metrics}
              value={metric}
              onChange={selectMetric}
              disabled={settings.saving || refreshing}
            />
            {!compact && (
              <Segments
                label="Usage period"
                options={periods}
                value={days}
                onChange={selectPeriod}
                disabled={metric === "limits" || settings.saving || refreshing}
              />
            )}
            <Button
              icon="RefreshCw"
              label={metric === "limits" ? "Check limits" : "Refresh usage"}
              disabled={metric === "limits" ? limitsFetching : refreshing || query.isFetching}
              onPress={() => void refresh()}
            />
          </View>
        </View>
        {compact && (
          <Segments
            label="Usage period"
            options={periods}
            value={days}
            onChange={selectPeriod}
            disabled={metric === "limits" || settings.saving || refreshing}
          />
        )}
        {metric !== "limits" && windowLabel && (
          <Label muted style={{ fontSize: 10 }}>
            {windowLabel} · {timeZone} · Provider history
          </Label>
        )}
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: compact ? 18 : 32,
          paddingVertical: compact ? 24 : 36,
        }}
      >
        <View style={{ width: "100%", maxWidth: 1280, alignSelf: "center", gap: 28 }}>
          {settings.saveError && (
            <Label style={{ color: c.statusDanger }}>{settings.saveError}</Label>
          )}
          {metric === "limits" ? (
            <Limits
              hostId={host.id}
              hidden={values.hiddenProviders}
              onProviders={setLimitProviders}
            />
          ) : (
            <>
              {refreshError && (
                <Label style={{ color: c.statusDanger }}>
                  Could not refresh usage. The last successful totals remain visible. Try again.
                </Label>
              )}
              {query.isPending && <UsageSkeleton compact={compact} />}
              {query.isError && (
                <View style={{ gap: 12 }}>
                  <Label>Could not read usage history on this host.</Label>
                  <Button onPress={() => void query.refetch()}>Try again</Button>
                </View>
              )}
              {summary && (
                <View style={{ gap: 28, opacity: refreshing ? 0.5 : 1 }}>
                  {summary.warnings.length > 0 && (
                    <View style={{ gap: 6 }}>
                      {summary.warnings.map((warning, index) => (
                        <Label key={index} style={{ color: c.statusWarning }}>
                          {warning}
                        </Label>
                      ))}
                    </View>
                  )}
                  <Overview
                    summary={summary}
                    metric={metric}
                    keys={keys}
                    hourly={days === 1}
                    compact={compact}
                  />
                  <Section title="Totals">
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 20 }}>
                      {[
                        ["Processed tokens", count(summary.totals.tokens)],
                        ["Cached input", count(summary.totals.cached)],
                        ["Uncached input", count(summary.totals.input)],
                        ["Output", count(summary.totals.output)],
                        ["Cache savings", money(summary.totals.savings)],
                      ].map(([label, value]) => (
                        <View
                          key={label}
                          style={{ flexBasis: compact ? "42%" : 135, flexGrow: 1, gap: 3 }}
                        >
                          <Label muted style={{ fontSize: 11 }}>
                            {label}
                          </Label>
                          <Label style={[styles.number, { fontSize: 17, fontWeight: "500" }]}>
                            {value}
                          </Label>
                        </View>
                      ))}
                    </View>
                  </Section>
                  {summary.totals.tokens > 0 && <Mix totals={summary.totals} metric={metric} />}
                  <Breakdown
                    summary={summary}
                    metric={metric}
                    hourly={days === 1}
                    compact={compact}
                    onSelect={setModel}
                  />
                  <View style={{ gap: 6 }}>
                    <Label muted style={{ fontSize: 10 }}>
                      API-equivalent estimates are not your subscription bill. Based on available
                      provider session history. Open History sources from the host menu to check
                      locations.
                    </Label>
                    <View style={[styles.between, { flexWrap: "wrap" }]}>
                      <Label muted style={{ fontSize: 10 }}>
                        Updated {new Date(summary.fetchedAt).toLocaleString()} · {timeZone}
                      </Label>
                      <Button icon="SlidersHorizontal" onPress={() => openPrices()}>
                        Model prices
                      </Button>
                    </View>
                  </View>
                </View>
              )}
            </>
          )}
        </View>
      </ScrollView>
      {filter && (
        <Modal
          title={filter === "providers" ? "Usage providers" : "Environment"}
          open
          onOpenChange={(open) => {
            if (!open) setFilter(null);
          }}
        >
          <Modal.Content>
            {filter === "providers" ? (
              <>
                <Label muted>Filter costs, tokens, and limits.</Label>
                {knownProviders.map((provider) => (
                  <Button
                    key={provider}
                    selected={!values.hiddenProviders.includes(provider)}
                    disabled={settings.saving}
                    icon={!values.hiddenProviders.includes(provider) ? "Check" : "Minus"}
                    onPress={() =>
                      void save({
                        hiddenProviders: values.hiddenProviders.includes(provider)
                          ? values.hiddenProviders.filter((p) => p !== provider)
                          : [...values.hiddenProviders, provider],
                      })
                    }
                  >
                    {providerLabel(provider)}
                  </Button>
                ))}
                <Button onPress={() => setFilter(null)}>Done</Button>
              </>
            ) : (
              <>
                <View style={styles.between}>
                  <Label style={{ fontWeight: "500" }}>{host.label}</Label>
                  <Label muted>Current Paseo host</Label>
                </View>
                {summary?.sources.map((source) => (
                  <View key={source.provider} style={{ gap: 4 }}>
                    <View style={styles.between}>
                      <Label muted>{providerLabel(source.provider)}</Label>
                      <Label>
                        {source.status === "missing"
                          ? "No history found"
                          : source.provider === "cursor"
                            ? source.files + " accounts"
                            : source.files + " history files"}
                      </Label>
                    </View>
                    {source.message && (
                      <Label muted style={{ fontSize: 11 }}>
                        {source.message}
                      </Label>
                    )}
                  </View>
                ))}
                <Button icon="SlidersHorizontal" onPress={() => openPrices()}>
                  Model prices
                </Button>
                <Button
                  icon="FolderOpen"
                  onPress={() => {
                    setFilter(null);
                    setEditor("sources");
                  }}
                >
                  History sources
                </Button>
              </>
            )}
          </Modal.Content>
        </Modal>
      )}
      {model && summary && (
        <ModelDetail
          model={model}
          keys={keys}
          metric={metric === "limits" ? "cost" : metric}
          hourly={days === 1}
          until={summary.until}
          onClose={() => setModel(null)}
          onPrice={() => {
            openPrices(model.model);
            setModel(null);
          }}
        />
      )}
      {editor === "prices" && (
        <PriceEditor
          values={values}
          models={summary?.models ?? []}
          initialModel={priceModel}
          saving={settings.saving}
          error={settings.saveError}
          onSave={save}
          onClose={() => setEditor(null)}
        />
      )}
      {editor === "sources" && (
        <SourceEditor
          values={values}
          saving={settings.saving}
          error={settings.saveError}
          onSave={save}
          onClose={() => setEditor(null)}
        />
      )}
    </View>
  );
}
function Overview({
  summary,
  metric,
  keys,
  hourly,
  compact,
}: {
  summary: UsageSummary;
  metric: "cost" | "tokens";
  keys: string[];
  hourly: boolean;
  compact: boolean;
}) {
  const c = useColors();
  return (
    <View style={{ flexDirection: compact ? "column" : "row", gap: compact ? 28 : 40 }}>
      <View style={{ width: compact ? "100%" : 288, gap: 20 }}>
        <View style={{ gap: 3 }}>
          <Label
            style={[
              styles.number,
              { fontSize: 36, lineHeight: 44, fontWeight: "600", letterSpacing: -1 },
            ]}
          >
            {metric === "cost" ? costLabel(summary.totals) : count(summary.totals.tokens)}
          </Label>
          <Label muted style={{ fontSize: 11 }}>
            {summary.sessions.toLocaleString()} sessions{metric === "cost" ? " · API estimate" : ""}
          </Label>
        </View>
        {summary.providers.map((provider) => (
          <View key={provider.provider} style={{ gap: 4 }}>
            <View style={styles.between}>
              <View style={styles.row}>
                <View
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 4,
                    backgroundColor: providerColor(provider.provider, c.foreground),
                  }}
                />
                <ProviderMark provider={provider.provider} />
                <Label>{providerLabel(provider.provider)}</Label>
                <Label muted style={{ fontSize: 10 }}>
                  {provider.sessions} sessions
                </Label>
              </View>
              <Label style={[styles.number, { fontWeight: "500" }]}>
                {metric === "cost" ? costLabel(provider) : count(provider.tokens)}
              </Label>
            </View>
            <Label muted style={{ fontSize: 11 }}>
              {percent(summary.totals[metric] ? provider[metric] / summary.totals[metric] : 0)} of{" "}
              {metric} ·{" "}
              {metric === "cost" ? count(provider.tokens) + " tokens" : costLabel(provider)}
            </Label>
          </View>
        ))}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 10 }}>
        <Label style={{ fontWeight: "500" }}>
          {hourly ? "Hourly" : "Daily"} {metric === "cost" ? "cost" : "processed tokens"}
        </Label>
        <UsageChart
          buckets={summary.buckets}
          keys={keys}
          providers={summary.providers.map((p) => p.provider)}
          metric={metric}
          hourly={hourly}
          until={summary.until}
        />
      </View>
    </View>
  );
}
function UsageSkeleton({ compact }: { compact: boolean }) {
  const c = useColors();
  const block = (width: number | `${number}%`, height: number) => (
    <View style={{ width, height, borderRadius: 4, backgroundColor: c.surface2, opacity: 0.5 }} />
  );
  return (
    <View accessibilityLabel="Loading usage" style={{ gap: 32 }}>
      <View style={{ flexDirection: compact ? "column" : "row", gap: 40 }}>
        <View style={{ gap: 16, width: 288 }}>
          {block(190, 40)}
          {block(120, 12)}
          {block("100%", 24)}
          {block("100%", 24)}
        </View>
        <View style={{ flex: 1 }}>{block("100%", 210)}</View>
      </View>
      <View style={{ flexDirection: "row", gap: 24 }}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={{ flex: 1, gap: 12 }}>
            {block("80%", 12)}
            {block("70%", 20)}
          </View>
        ))}
      </View>
      {block("100%", 180)}
    </View>
  );
}
