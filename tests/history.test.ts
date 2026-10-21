import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { mkdtemp, mkdir, rm, writeFile, appendFile, copyFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialCodexScanState, parseCodexLine } from "../server/codex";
import { parseClaudeLine } from "../server/claude";
import { HistoryReader } from "../server/history";
import { usageSettings } from "../shared/usage";

const roots: string[] = [];
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-unused-sources-"));
  roots.push(root);
  vi.stubEnv("AGENT_CLI_CREDENTIAL_STORE", "memory");
  for (const key of [
    "GROK_HOME",
    "PI_CODING_AGENT_SESSION_DIR",
    "OPENCODE_DATA_DIR",
    "ANTIGRAVITY_DATA_DIR",
    "XDG_CONFIG_HOME",
  ])
    vi.stubEnv(key, join(root, key));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const stamp = new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value);
const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cached_input_tokens: input / 5,
  total_tokens: input + output,
});
const event = (last = usage(100, 10), total = last, timestamp = stamp) => ({
  type: "event_msg",
  timestamp,
  payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } },
});
const meta = (id: string, fork = false) => ({
  type: "session_meta",
  timestamp: stamp,
  payload: { id, model_provider: "openai", ...(fork ? { forked_from_id: "parent" } : {}) },
});
const context = {
  type: "turn_context",
  timestamp: stamp,
  payload: { model: "gpt-5", turn_id: "turn" },
};
const claude = {
  type: "assistant",
  timestamp: stamp,
  sessionId: "claude-session",
  requestId: "request",
  message: {
    id: "message",
    model: "claude-sonnet-4-6",
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
      output_tokens: 40,
    },
  },
};

test("Codex ignores cumulative re-emissions and counts cached/reasoning tokens once", () => {
  const state = initialCodexScanState();
  parseCodexLine(json(meta("session")), state);
  parseCodexLine(json(context), state);
  const record = parseCodexLine(json(event()), state);
  expect(record?.totals).toMatchObject({
    uncachedInputTokens: 80,
    cachedInputTokens: 20,
    outputTokens: 10,
  });
  expect(parseCodexLine(json(event()), state)).toBeNull();
  expect(
    parseCodexLine(json(event(usage(100, 10), usage(200, 20))), state)?.totals.outputTokens,
  ).toBe(10);
  expect(state.malformedRecords).toBe(0);
});
test("fork copies establish a baseline but do not count as new billed history", () => {
  const state = initialCodexScanState();
  parseCodexLine(json(meta("child", true)), state);
  parseCodexLine(json(meta("parent")), state);
  parseCodexLine(json(context), state);
  expect(parseCodexLine(json(event()), state)).toBeNull();
  const later = new Date(Date.parse(stamp) + 5000).toISOString();
  const record = parseCodexLine(json(event(usage(100, 10), usage(200, 20), later)), state);
  expect(record?.sessionId).toBe("child");
  expect(record?.totals.uncachedInputTokens).toBe(80);
});
test("invalid counter deltas and synthetic Claude messages are excluded", () => {
  const state = initialCodexScanState();
  parseCodexLine(json(context), state);
  expect(parseCodexLine(json(event(usage(100, 10), usage(300, 10))), state)).toBeNull();
  expect(state.malformedRecords).toBe(1);
  expect(
    parseClaudeLine(json({ ...claude, message: { ...claude.message, model: "<synthetic>" } })),
  ).toBeNull();
  expect(parseClaudeLine(json(claude))?.totals.cacheCreationTokens).toBe(30);
});
test("real JSONL scan deduplicates archive copies and Claude blocks; changed files invalidate the cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-usage-"));
  roots.push(root);
  const codexHome = join(root, "codex"),
    claudeHome = join(root, "claude");
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  await mkdir(join(codexHome, "archived_sessions"));
  await mkdir(join(claudeHome, "projects"), { recursive: true });
  vi.stubEnv("CODEX_HOME", codexHome);
  vi.stubEnv("CLAUDE_CONFIG_DIR", claudeHome);
  const file = join(codexHome, "sessions", "rollout.jsonl");
  await writeFile(file, [meta("session"), context, event()].map(json).join("\n") + "\n");
  await copyFile(file, join(codexHome, "archived_sessions", "copy.jsonl"));
  await writeFile(
    join(claudeHome, "projects", "blocks.jsonl"),
    [claude, claude].map(json).join("\n") + "\n",
  );
  await writeFile(join(codexHome, "sessions", "auth.json"), '{"token":"must-not-read"}');
  await symlink(root, join(codexHome, "sessions", "loop"));
  const reader = new HistoryReader(),
    settings = usageSettings.schema.parse({});
  const first = await reader.read(settings);
  expect(first.records).toHaveLength(2);
  expect(first.sources.slice(0, 2).map((s) => s.records)).toEqual([1, 1]);
  expect(first.sources.slice(0, 2).map((s) => s.files)).toEqual([2, 1]);
  await appendFile(
    file,
    json(event(usage(100, 10), usage(200, 20), new Date(Date.parse(stamp) + 100).toISOString())) +
      "\n",
  );
  const next = await reader.read(settings);
  expect(next.records).toHaveLength(3);
  expect(next.sources.slice(0, 2).every((s) => s.status === "ready")).toBe(true);
  expect(JSON.stringify(next)).not.toContain("must-not-read");
});

test("distinct requests with identical timestamps and token amounts count once each across rollout copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-usage-occurrences-"));
  roots.push(root);
  vi.stubEnv("CODEX_HOME", join(root, "codex"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude"));
  const sessions = join(root, "codex", "sessions");
  const archives = join(root, "codex", "archived_sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(archives);
  const file = join(sessions, "original.jsonl");
  await writeFile(
    file,
    [meta("identical-requests"), context, event(), event(usage(100, 10), usage(200, 20))]
      .map(json)
      .join("\n") + "\n",
  );
  await copyFile(file, join(archives, "copy.jsonl"));
  const result = await new HistoryReader().read(usageSettings.schema.parse({}));
  expect(result.records).toHaveLength(2);
  expect(
    result.records.reduce(
      (sum, r) =>
        sum + r.totals.uncachedInputTokens + r.totals.cachedInputTokens + r.totals.outputTokens,
      0,
    ),
  ).toBe(220);
});

test("only present CLI logs contribute; the in-memory cache cannot invent history after a log is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-usage-present-logs-"));
  roots.push(root);
  vi.stubEnv("CODEX_HOME", join(root, "codex"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude"));
  const sessions = join(root, "codex", "sessions");
  await mkdir(sessions, { recursive: true });
  const file = join(sessions, "present.jsonl");
  await writeFile(file, [meta("present"), context, event()].map(json).join("\n") + "\n");
  // An unrelated application's saved numeric data is never a usage source.
  await writeFile(
    join(root, "other-app-cache.json"),
    JSON.stringify({ tokens: 999999999, model: "foreign" }),
  );
  const reader = new HistoryReader(),
    settings = usageSettings.schema.parse({});
  expect((await reader.read(settings)).records).toHaveLength(1);
  await rm(file);
  expect((await reader.read(settings)).records).toHaveLength(0);
  expect((await new HistoryReader().read(settings)).records).toHaveLength(0);
});
