import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createElement as h, useState } from "react";
import { usageSettings, type UsageSettings } from "../shared/usage";
import { summarize } from "../server/summary";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import type { UsageRecord } from "../server/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  save: vi.fn(),
  limits: vi.fn(),
  initialSettings: {} as Partial<UsageSettings>,
}));
vi.mock("react-native", () => ({
  View: "View",
  Image: "Image",
  PixelRatio: { get: () => 2 },
  processColor: () => 0xffeeeeee,
  ScrollView: "ScrollView",
  Text: "Text",
  Pressable: "Pressable",
  TextInput: "TextInput",
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useSettings: () => {
    const [values, setValues] = useState(usageSettings.schema.parse(mock.initialSettings));
    return {
      status: "ready",
      values,
      revision: "1",
      saving: false,
      saveError: null,
      save: async (next: UsageSettings) => {
        mock.save(next);
        setValues(next);
        return true;
      },
    };
  },
  useRpc: () => mock.rpc,
  usePaseo: () => ({ providers: { listUsage: mock.limits } }),
}));
vi.mock("@getpaseo/plugin/client/react-native", () => {
  const Modal = Object.assign((props: { children: unknown }) => h("Modal", props as never), {
    Content: (props: { children: unknown }) => h("ModalContent", props as never),
  });
  return { Modal, TextInput: "TextInput", Icon: "Icon" };
});
const { UsageScreen } = await import("../client/screen");
const colors = {
  surface0: "#111",
  surface1: "#222",
  surface2: "#333",
  border: "#444",
  foreground: "#eee",
  foregroundMuted: "#999",
  accent: "#eee",
  accentForeground: "#111",
  statusSuccess: "green",
  statusWarning: "orange",
  statusDanger: "red",
};
const props: PluginScreenProps = {
  theme: { colors },
  host: { id: "test", label: "Test host" },
  layout: { platform: "ios", compact: false },
  params: {},
};
const record: UsageRecord = {
  provider: "codex",
  model: "model",
  timestampMs: Date.now(),
  sessionId: "session",
  totals: {
    uncachedInputTokens: 100,
    cachedInputTokens: 20,
    cacheCreationTokens: 0,
    outputTokens: 30,
    reasoningTokens: 10,
  },
  speed: "standard",
  reportedCostUsd: null,
  dedupeKey: null,
};
let renderer: ReactTestRenderer | undefined;
let queryClient: QueryClient | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  queryClient?.clear();
  renderer = undefined;
  mock.rpc.mockReset();
  mock.save.mockReset();
  mock.limits.mockReset();
  mock.initialSettings = {};
  vi.useRealTimers();
});
async function render(compact = false, records = [record]) {
  const settings = usageSettings.schema.parse({
    prices: { model: { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 } },
  });
  mock.rpc.mockImplementation(
    async (input: { days: 1 | 7 | 30 | 90; hiddenProviders: string[]; timeZone: string }) =>
      summarize(records, [], settings, input),
  );
  mock.limits.mockResolvedValue({
    providers: [
      {
        providerId: "codex",
        displayName: "Codex",
        planLabel: "Test plan",
        status: "available",
        windows: [
          {
            id: "5h",
            label: "Session",
            usedPct: 20,
            resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        ],
      },
    ],
  });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      h(
        QueryClientProvider,
        { client: queryClient! },
        h(UsageScreen, { ...props, layout: { ...props.layout, compact } }),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
function button(label: string) {
  return renderer!.root.findAll(
    (node) => node.type === ("Pressable" as unknown) && node.props.accessibilityLabel === label,
  )[0];
}
function screenText() {
  return renderer!.root
    .findAll((node) => node.type === ("Text" as unknown))
    .map((node) =>
      node.children.filter((child): child is string => typeof child === "string").join(""),
    );
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

test("warning banners stay hidden while unpriced labels remain in totals, periods and models", async () => {
  const unknown = { ...record, model: "unknown" };
  await render(false, [unknown]);
  await act(async () => button("7 days").props.onPress());
  await settle();
  const warning = "One provider history could not be read.";
  mock.rpc.mockResolvedValueOnce(
    summarize(
      [unknown],
      [{ provider: "pi", files: 1, records: 0, status: "partial", message: warning }],
      usageSettings.schema.parse({}),
      { days: 7, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, hiddenProviders: [] },
    ),
  );
  await act(async () => button("Refresh usage").props.onPress());
  expect(screenText()).not.toContain(warning);
  expect(screenText().some((text) => text.includes("no known model price"))).toBe(false);
  expect(screenText().filter((text) => text === "Unpriced")).toHaveLength(3);
  expect(
    renderer!.root.findAll(
      (node) =>
        node.type === ("Pressable" as unknown) &&
        node.props.accessibilityLabel?.endsWith(": Unpriced"),
    ),
  ).toHaveLength(1);
  await act(async () => button("Day").props.onPress());
  expect(screenText().filter((text) => text === "Unpriced")).toHaveLength(3);
  await act(async () => button("Model").props.onPress());
  await act(async () => button("Usage for unknown").props.onPress());
  expect(screenText().filter((text) => text === "Unpriced")).toHaveLength(5);
});

test("mixed priced and unknown usage shows amounts without partial suffixes and keeps unknown model costs unpriced", async () => {
  await render(false, [record, { ...record, model: "unknown" }]);
  await act(async () => button("7 days").props.onPress());
  await settle();
  expect(screenText().some((text) => text.includes(" · partial"))).toBe(false);
  expect(screenText()).toContain("Unpriced");
  const columns = renderer!.root.findAll(
    (node) =>
      node.type === ("Pressable" as unknown) &&
      node.props.accessibilityLabel?.endsWith(": $0.0002"),
  );
  expect(columns).toHaveLength(1);
  await act(async () => columns[0].props.onHoverIn());
  expect(screenText().some((text) => text === "Codex $0.0002")).toBe(true);
  await act(async () => button("Day").props.onPress());
  expect(screenText().some((text) => text.includes(" · partial"))).toBe(false);
});

test("limits keep duplicate account cards distinct and allow filtering limits-only providers", async () => {
  await render();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const account = {
      providerId: "codex",
      displayName: "Codex",
      status: "available",
      windows: [{ id: "session", label: "Session", remainingPct: 80 }],
    };
    mock.limits.mockResolvedValue({
      providers: [
        account,
        { ...account, windows: [{ ...account.windows[0], remainingPct: 25 }] },
        { ...account, providerId: "copilot", displayName: "GitHub Copilot" },
      ],
    });
    await act(async () => button("Limits").props.onPress());
    await settle();
    expect(
      renderer!.root
        .findAllByProps({ accessibilityRole: "progressbar" })
        .map((node) => node.props.accessibilityValue.now),
    ).toEqual([80, 25, 80]);
    expect(
      errors.mock.calls.some((args) => args.some((arg) => String(arg).includes("same key"))),
    ).toBe(false);
    expect(screenText().some((text) => text.includes("5 minutes"))).toBe(true);
    await act(async () => button("All providers").props.onPress());
    await act(async () => button("GitHub Copilot").props.onPress());
    expect(mock.save.mock.lastCall?.[0].hiddenProviders).toEqual(["copilot"]);
    await act(async () => button("Done").props.onPress());
    expect(renderer!.root.findAllByProps({ accessibilityRole: "progressbar" })).toHaveLength(2);
    await act(async () => button("Check limits").props.onPress());
    await settle();
    expect(mock.limits).toHaveBeenCalledTimes(2);
    expect(mock.limits.mock.lastCall).toEqual([]);
  } finally {
    errors.mockRestore();
  }
});

test("checking limits keeps existing readings visible and preserves them if the check fails", async () => {
  await render();
  await act(async () => button("Limits").props.onPress());
  await settle();
  const lastCheck = screenText().find((text) => text.startsWith("Last successful host check"));
  let fail!: (error: Error) => void;
  mock.limits.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  await act(async () => button("Check limits").props.onPress());
  await settle();
  expect(button("Check limits").props.accessibilityState.disabled).toBe(true);
  expect(
    renderer!.root.findByProps({ accessibilityRole: "progressbar" }).props.accessibilityValue.now,
  ).toBe(80);
  await act(async () => fail(new Error("offline")));
  await settle();
  expect(button("Check limits").props.accessibilityState.disabled).toBe(false);
  expect(screenText()).toContain("Could not check limits. Showing the last successful values.");
  expect(screenText()).toContain(lastCheck);
  expect(
    renderer!.root.findByProps({ accessibilityRole: "progressbar" }).props.accessibilityValue.now,
  ).toBe(80);
});

test("the right edge shows the last successful refresh time while retaining hourly totals", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const stamp = new Date(2026, 9, 21, 15, 33);
  vi.setSystemTime(stamp);
  await render(false, [{ ...record, timestampMs: new Date(2026, 9, 21, 15, 15).getTime() }]);
  await act(async () => button("Tokens").props.onPress());
  await act(async () => button("Past 24h").props.onPress());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(button("15h33: 150")).toBeDefined();
  expect(button("14h00: 0")).toBeDefined();
  vi.setSystemTime(new Date(2026, 9, 21, 15, 40));
  await act(async () => button("15h33: 150").props.onHoverIn());
  const hoveredText = () =>
    renderer!.root
      .findAll((node) => node.type === ("Text" as unknown))
      .map((node) =>
        node.children.filter((child): child is string => typeof child === "string").join(""),
      );
  expect(hoveredText()).toContain("15h33 · 150");
  vi.setSystemTime(new Date(2026, 9, 21, 15, 47));
  await act(async () => button("Refresh usage").props.onPress());
  expect(button("15h47: 150")).toBeDefined();
  expect(hoveredText()).toContain("15h47 · 150");
  vi.setSystemTime(new Date(2026, 9, 21, 15, 59));
  mock.rpc.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Refresh usage").props.onPress());
  expect(button("15h47: 150")).toBeDefined();
  await act(async () => button("Usage for model").props.onPress());
  const rightEdges = renderer!.root.findAll(
    (node) =>
      node.type === ("Pressable" as unknown) && node.props.accessibilityLabel === "15h47: 150",
  );
  expect(rightEdges).toHaveLength(2);
  await act(async () => rightEdges[1].props.onHoverIn());
  expect(hoveredText().filter((text) => text === "15h47 · 150")).toHaveLength(2);
});

test("visits start with 24 hours even when a wider period was saved, and keep explicit selections", async () => {
  mock.initialSettings = { days: 30 };
  await render();
  expect(mock.rpc.mock.calls[0][0].days).toBe(1);
  expect(button("Past 24h").props.accessibilityState.selected).toBe(true);
  await act(async () => button("30 days").props.onPress());
  await settle();
  expect(mock.rpc.mock.lastCall?.[0].days).toBe(30);
  await act(async () => button("Tokens").props.onPress());
  expect(button("30 days").props.accessibilityState.selected).toBe(true);
});

test("background loading statuses preserve the current period and clear after a completed response", async () => {
  await render();
  const summary = summarize([record], [], usageSettings.schema.parse({}), {
    days: 1,
    timeZone: "UTC",
    hiddenProviders: [],
  });
  mock.rpc.mockResolvedValueOnce({ ...summary, historyLoading: true, pricingRefreshing: true });
  await act(async () => button("Refresh usage").props.onPress());
  expect(screenText().some((text) => text.includes("Loading older history…"))).toBe(true);
  expect(screenText().some((text) => text.includes("Updating prices…"))).toBe(true);
  expect(button("Past 24h").props.accessibilityState.selected).toBe(true);
  mock.rpc.mockResolvedValueOnce({ ...summary, historyLoading: false, pricingRefreshing: false });
  await act(async () => button("Refresh usage").props.onPress());
  expect(screenText().some((text) => text.includes("Loading older history…"))).toBe(false);
  expect(screenText().some((text) => text.includes("Updating prices…"))).toBe(false);
});

test("an open model detail receives updated usage when background results arrive", async () => {
  await render();
  await act(async () => button("Usage for model").props.onPress());
  const updated = summarize(
    [{ ...record, totals: { ...record.totals, outputTokens: 180 } }],
    [],
    usageSettings.schema.parse({}),
    {
      days: 1,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hiddenProviders: [],
    },
  );
  await act(async () => {
    queryClient!.setQueriesData({ queryKey: ["usage-summary"] }, updated);
  });
  await settle();
  expect(screenText().filter((text) => text === "300").length).toBeGreaterThanOrEqual(3);
});
test("the rendered screen switches metric and periods, opens a model, and reads limits through Paseo", async () => {
  await render();
  expect(button("Usage for model")).toBeDefined();
  await act(async () => button("Tokens").props.onPress());
  expect(mock.save.mock.lastCall?.[0].metric).toBe("tokens");
  await act(async () => button("Past 24h").props.onPress());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(mock.rpc.mock.lastCall?.[0].days).toBe(1);
  await act(async () => button("Usage for model").props.onPress());
  expect(button("Set price")).toBeDefined();
  await act(async () => button("Set price").props.onPress());
  expect(renderer!.root.findAllByProps({ title: "Model prices" }).length).toBeGreaterThan(0);
  await act(async () => button("Cancel").props.onPress());
  await act(async () => button("Limits").props.onPress());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(mock.limits).toHaveBeenCalledOnce();
  expect(
    renderer!.root.findByProps({ accessibilityRole: "progressbar" }).props.accessibilityValue.now,
  ).toBe(80);
});
test("compact provider filtering updates totals without showing stale models", async () => {
  await render(true);
  await act(async () => button("All providers").props.onPress());
  await act(async () => button("Codex").props.onPress());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(mock.save.mock.lastCall?.[0].hiddenProviders).toEqual(["codex"]);
  await act(async () => button("Done").props.onPress());
  expect(button("Usage for model")).toBeUndefined();
  expect(mock.rpc.mock.lastCall?.[0].hiddenProviders).toEqual(["codex"]);
});

test("History sources exposes and saves all provider locations, with Keychain access off by default", async () => {
  await render();
  await act(async () => button("Test host").props.onPress());
  await act(async () => button("History sources").props.onPress());
  const fields = [
    "Additional Codex homes",
    "Additional Claude homes",
    "Additional Grok homes",
    "Additional Pi session directories",
    "Additional OpenCode data directories",
    "Additional Antigravity data directories",
    "Additional Cursor CLI login files",
  ];
  for (const field of fields)
    expect(renderer!.root.findByProps({ accessibilityLabel: field })).toBeDefined();
  expect(button("Allow Cursor Keychain access on macOS").props.accessibilityState.selected).toBe(
    false,
  );
  await act(async () =>
    renderer!.root
      .findByProps({ accessibilityLabel: "Additional OpenCode data directories" })
      .props.onChangeText("~/work-opencode\n~/work-opencode\n /tmp/synthetic-opencode "),
  );
  await act(async () =>
    renderer!.root
      .findByProps({ accessibilityLabel: "Additional Pi session directories" })
      .props.onChangeText("~/pi-sessions"),
  );
  await act(async () => button("Save sources").props.onPress());
  expect(mock.save.mock.lastCall?.[0]).toMatchObject({
    opencodeDataDirs: ["~/work-opencode", "/tmp/synthetic-opencode"],
    piSessionDirs: ["~/pi-sessions"],
    cursorKeychainEnabled: false,
  });
  await act(async () => button("All providers").props.onPress());
  for (const label of ["Grok Build", "Pi", "Cursor", "OpenCode", "Antigravity"])
    expect(button(label)).toBeDefined();
});
