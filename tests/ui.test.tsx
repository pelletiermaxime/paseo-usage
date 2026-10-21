import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createElement as h, useState } from "react";
import { usageSettings, type UsageSettings } from "../shared/usage";
import { summarize } from "../server/summary";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import type { UsageRecord } from "../server/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mock = vi.hoisted(() => ({ rpc: vi.fn(), save: vi.fn(), limits: vi.fn() }));
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
    const [values, setValues] = useState(usageSettings.schema.parse({}));
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
});
async function render(compact = false) {
  const settings = usageSettings.schema.parse({
    prices: { model: { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 } },
  });
  mock.rpc.mockImplementation(
    async (input: { days: 1 | 7 | 30 | 90; hiddenProviders: string[]; timeZone: string }) =>
      summarize([record], [], settings, input),
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
