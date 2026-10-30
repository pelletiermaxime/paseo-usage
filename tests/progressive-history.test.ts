import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { ProgressiveHistoryReader } from "../server/progressive-history";
import { HistoryReader } from "../server/history";
import { usageSettings } from "../shared/usage";
import { readTranscript } from "../server/transcript";
import { UsageService } from "../server/usage-service";
import { PriceCatalog } from "../server/catalog";

vi.mock("../server/transcript", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/transcript")>();
  return { ...actual, readTranscript: vi.fn(actual.readTranscript) };
});
const actualRead = (
  await vi.importActual<typeof import("../server/transcript")>("../server/transcript")
).readTranscript;
let root: string;
const readers: ProgressiveHistoryReader[] = [];
const jobs: Promise<unknown>[] = [];
const settings = usageSettings.schema.parse({});
const tokens = (records: Awaited<ReturnType<HistoryReader["read"]>>["records"]) =>
  records.reduce(
    (sum, r) =>
      sum + r.totals.uncachedInputTokens + r.totals.cachedInputTokens + r.totals.outputTokens,
    0,
  );
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function reader() {
  const value = new ProgressiveHistoryReader();
  readers.push(value);
  return value;
}
const usage = (n: number) => ({
  input_tokens: n * 100,
  output_tokens: n * 10,
  total_tokens: n * 110,
});
const event = (timestamp: string, n = 1) =>
  JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: { last_token_usage: usage(1), total_token_usage: usage(n) },
    },
  });
async function rollout(
  id: string,
  hoursAgo: number,
  compressed = false,
  home = process.env.CODEX_HOME!,
) {
  const timestamp = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  const directory = join(home, "sessions");
  await mkdir(directory, { recursive: true });
  const file = join(directory, id + (compressed ? ".jsonl.zst" : ".jsonl"));
  const content =
    [
      JSON.stringify({ type: "session_meta", timestamp, payload: { id } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5" } }),
      event(timestamp),
    ].join("\n") + "\n";
  await writeFile(file, compressed ? zstdCompressSync(Buffer.from(content)) : content);
  await utimes(file, new Date(timestamp), new Date(timestamp));
  return file;
}
async function waitUntilAbortedOrReleased(signal: AbortSignal | undefined, release: Promise<void>) {
  await new Promise<void>((resolve) => {
    const finish = () => {
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    signal?.addEventListener("abort", finish, { once: true });
    void release.then(finish);
  });
  signal?.throwIfAborted();
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paseo-progressive-"));
  for (const name of [
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "GROK_HOME",
    "PI_CODING_AGENT_SESSION_DIR",
    "OPENCODE_DATA_DIR",
    "ANTIGRAVITY_DATA_DIR",
    "XDG_CONFIG_HOME",
  ])
    vi.stubEnv(name, join(root, name));
  vi.stubEnv("AGENT_CLI_CREDENTIAL_STORE", "memory");
});
afterEach(async () => {
  for (const value of readers.splice(0)) value.dispose();
  await Promise.allSettled(jobs.splice(0));
  vi.mocked(readTranscript).mockReset().mockImplementation(actualRead);
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

test("recent data returns before old-file parsing; warming recovers compressed and restored recent usage", async () => {
  await rollout("recent", 1);
  await rollout("archived", 72, true);
  const restored = await rollout("restored", 2);
  const oldTime = new Date(Date.now() - 72 * 3_600_000);
  await utimes(restored, oldTime, oldTime);
  const value = reader();
  const first = await value.read(settings, 1);
  expect(first.historyLoading).toBe(true);
  expect(first.records.map((r) => r.sessionId)).toEqual(["recent"]);
  expect(vi.mocked(readTranscript).mock.calls.some(([path]) => path === restored)).toBe(false);
  const full = await value.read(settings, 30);
  expect(full.historyLoading).toBe(false);
  expect(full.records).toHaveLength(3);
  const recent = await value.read(settings, 1);
  expect(recent.historyLoading).toBe(false);
  expect(recent.records.filter((r) => r.timestampMs >= Date.now() - 86_400_000)).toHaveLength(2);
  expect(tokens(recent.records)).toBe(tokens((await new HistoryReader().read(settings)).records));
});

test("a wide request waiting on warm-up does not block a recent refresh or reparse cached files", async () => {
  const recent = await rollout("recent", 1);
  const old = await rollout("old", 72, true);
  const started = deferred(),
    release = deferred();
  vi.mocked(readTranscript).mockImplementation(async (path, provider, previous, options) => {
    if (path === old && options?.beforeRead) {
      started.resolve();
      await waitUntilAbortedOrReleased(options.signal, release.promise);
    }
    return actualRead(path, provider, previous, options);
  });
  const value = reader();
  await value.read(settings, 1);
  await started.promise;
  const wide = value.read(settings, 90);
  jobs.push(wide);
  await appendFile(recent, event(new Date().toISOString(), 2) + "\n");
  const refreshed = await value.read(settings, 1, true);
  expect(tokens(refreshed.records)).toBe(220);
  expect(refreshed.historyLoading).toBe(true);
  const presentationChange = {
    ...settings,
    metric: "tokens" as const,
    days: 30 as const,
    hiddenProviders: ["claude"],
    prices: { "gpt-5": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 } },
  };
  expect(tokens((await value.read(presentationChange, 1)).records)).toBe(220);
  expect(
    vi.mocked(readTranscript).mock.calls.find(([path]) => path === old)?.[3]?.signal?.aborted,
  ).toBe(false);
  release.resolve();
  expect(tokens((await wide).records)).toBe(330);
  const calls = vi.mocked(readTranscript).mock.calls.length;
  await value.read(settings, 30);
  expect(vi.mocked(readTranscript).mock.calls).toHaveLength(calls);
});

test("a late background result cannot overwrite a foreground read of a changed file", async () => {
  const old = await rollout("old", 72);
  const snapshotReady = deferred(),
    release = deferred();
  vi.mocked(readTranscript).mockImplementation(async (path, provider, previous, options) => {
    const parsed = await actualRead(path, provider, previous, options);
    if (path === old && options?.beforeRead) {
      snapshotReady.resolve();
      await waitUntilAbortedOrReleased(options.signal, release.promise);
    }
    return parsed;
  });
  const value = reader();
  await value.read(settings, 1);
  await snapshotReady.promise;
  await appendFile(old, event(new Date().toISOString(), 2) + "\n");
  expect(tokens((await value.read(settings, 1)).records)).toBe(220);
  release.resolve();
  expect(tokens((await value.read(settings, 30)).records)).toBe(220);
  expect(tokens((await value.read(settings, 1)).records)).toBe(220);
});

test("source changes abort obsolete background work and cannot leak its records into the new scope", async () => {
  const homeA = join(root, "a"),
    homeB = join(root, "b");
  const old = await rollout("old-a", 72, true, homeA);
  await rollout("new-b", 1, false, homeB);
  const started = deferred(),
    release = deferred();
  vi.mocked(readTranscript).mockImplementation(async (path, provider, previous, options) => {
    if (path === old) {
      started.resolve();
      await waitUntilAbortedOrReleased(options?.signal, release.promise);
    }
    return actualRead(path, provider, previous, options);
  });
  const a = { ...settings, codexHomes: [homeA] },
    b = { ...settings, codexHomes: [homeB] };
  const value = reader();
  await value.read(a, 1);
  await started.promise;
  const abandoned = value.read(a, 30).catch((error: unknown) => error);
  jobs.push(abandoned);
  const next = await value.read(b, 1);
  expect(next.records.map((r) => r.sessionId)).toEqual(["new-b"]);
  expect(await abandoned).toBeInstanceOf(Error);
  const full = await value.read(b, 30);
  expect(full.records.map((r) => r.sessionId)).toEqual(["new-b"]);
  value.dispose();
  await expect(value.read(b, 1)).rejects.toThrow("disposed");
});

test("usage summaries return during a price download and update after history and prices finish", async () => {
  await rollout("recent", 1);
  let finish!: (value: unknown) => void;
  const prices = new PriceCatalog(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    join(root, "prices.json"),
  );
  const history = reader(),
    service = new UsageService(history, prices);
  const input = { days: 1 as const, timeZone: "UTC", hiddenProviders: [], refresh: false };
  try {
    const first = await service.summary(settings, input);
    expect(first.pricingRefreshing).toBe(true);
    expect(first.totals.tokens).toBe(110);
    expect(first.totals.unpriced).toBe(1);
    finish({ "gpt-5": { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 } });
    await prices.get({ awaitRefresh: true });
    await history.read(settings, 30);
    const updated = await service.summary(settings, input);
    expect(updated.pricingRefreshing).toBe(false);
    expect(updated.historyLoading).toBe(false);
    expect(updated.totals.tokens).toBe(first.totals.tokens);
    expect(updated.totals.unpriced).toBe(0);
    expect(updated.totals.cost).toBeCloseTo(0.00012);
  } finally {
    service.dispose();
  }
});
