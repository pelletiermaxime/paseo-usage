import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { appendFile, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryReader } from "../server/history";
import { OpenCodeReader, parseOpenCodeMessage } from "../server/opencode";
import { AntigravityReader } from "../server/antigravity";
import {
  CursorReader,
  readCursorAccountUsage,
  cursorRateModel,
  type CursorFetch,
} from "../server/cursor";
import { parsePiLine } from "../server/pi";
import { readTranscript } from "../server/transcript";
import { usageSettings, historyProviders } from "../shared/usage";
import { summaryRpc } from "../shared/usage";
import { summarize } from "../server/summary";
import { totalTokens } from "../server/types";

let root: string;
const stamp = new Date().toISOString(),
  now = Date.parse(stamp);
const json = (value: unknown) => JSON.stringify(value);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paseo-sources-test-"));
  for (const key of [
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "GROK_HOME",
    "PI_CODING_AGENT_SESSION_DIR",
    "OPENCODE_DATA_DIR",
    "ANTIGRAVITY_DATA_DIR",
    "XDG_CONFIG_HOME",
  ])
    vi.stubEnv(key, join(root, key));
  for (const key of ["CURSOR_AUTH_TOKEN", "CURSOR_API_KEY", "AGENT_CLI_CREDENTIAL_STORE"])
    vi.stubEnv(key, "");
  vi.stubEnv("AGENT_CLI_CREDENTIAL_STORE", "memory");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const piMessage = (id = "pi-message") => ({
  type: "message",
  id,
  timestamp: stamp,
  message: {
    role: "assistant",
    provider: "anthropic",
    model: "alias",
    responseModel: "claude-sonnet-4-6",
    usage: {
      input: 100,
      cacheRead: 20,
      cacheWrite: 5,
      output: 30,
      reasoning: 10,
      cost: { total: 0 },
    },
  },
});
const openCodeMessage = (id = "message") => ({
  id,
  role: "assistant",
  modelID: "gpt-5",
  sessionID: "session",
  time: { created: now },
  tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 30, write: 5 } },
  cost: 0,
});
const cursorToken = (id = "user-1") =>
  `header.${Buffer.from(json({ sub: `auth0|${id}` })).toString("base64url")}.signature`;
const cursorEvent = (index = 0) => ({
  timestamp: now,
  model: "cursor-grok-4-high-fast",
  conversationId: "conversation",
  tokenUsage: {
    inputTokens: 10 + index,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 1,
    totalCents: 0.5,
  },
});
const response = (body: unknown, status = 200) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;

test("Pi preserves actual model, disjoint caches, tool/summary costs, and fork identity", () => {
  const state = { sessionId: "" };
  expect(parsePiLine(json({ type: "session", id: "pi-session" }), state)).toEqual([]);
  const [record] = parsePiLine(json(piMessage()), state);
  expect(record).toMatchObject({
    provider: "pi",
    sessionId: "pi-session",
    model: "anthropic/claude-sonnet-4-6",
    rateModel: "claude-sonnet-4-6",
    reportedCostUsd: null,
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 20,
      cacheCreationTokens: 5,
      outputTokens: 30,
      reasoningTokens: 10,
    },
  });
  expect(parsePiLine(json(piMessage()), { sessionId: "fork" })[0].dedupeKey).toBe(record.dedupeKey);
  for (const type of ["compaction", "branch_summary", "usage"] as const) {
    const [auxiliary] = parsePiLine(
      json({
        type,
        id: type,
        timestamp: stamp,
        provider: "openai",
        model: "gpt-5",
        usage: { cost: { total: 0.03 } },
      }),
      state,
    );
    expect(auxiliary.model).toBe(type === "usage" ? "openai/gpt-5" : "Tools/summaries");
    expect(auxiliary.reportedCostUsd).toBe(0.03);
  }
  expect(
    parsePiLine(
      json({
        type: "message",
        id: "tool",
        timestamp: stamp,
        message: { role: "toolResult", usage: { input: 1 } },
      }),
      state,
    )[0].model,
  ).toBe("Tools/summaries");
});

test("Pi incremental reads and Grok multi-model unterminated tails match cold scans", async () => {
  const pi = join(root, "pi.jsonl");
  await writeFile(pi, [json({ type: "session", id: "pi-session" }), json(piMessage())].join("\n"));
  const first = await readTranscript(pi, "pi");
  await appendFile(pi, "\n" + json(piMessage("next")) + "\n");
  const next = await readTranscript(pi, "pi", first);
  expect(next.records).toEqual((await readTranscript(pi, "pi")).records);
  expect(next.records).toHaveLength(2);
  const grok = join(root, "updates.jsonl");
  await writeFile(
    grok,
    json({
      timestamp: now,
      params: {
        sessionId: "grok-session",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "turn",
          usage: { modelUsage: { a: { inputTokens: 5 }, b: { inputTokens: 6 } } },
        },
      },
    }),
  );
  const tail = await readTranscript(grok, "grok");
  expect(tail.tailRecords).toHaveLength(2);
  await appendFile(grok, "\n");
  const full = await readTranscript(grok, "grok", tail);
  expect(full.tailRecords).toEqual([]);
  expect(full.records).toEqual(tail.tailRecords);
});

test("OpenCode counts reasoning in output and prefers positive reported costs", () => {
  expect(parseOpenCodeMessage(json(openCodeMessage()))).toMatchObject({
    totals: { uncachedInputTokens: 100, outputTokens: 30, reasoningTokens: 10 },
    reportedCostUsd: null,
  });
  expect(parseOpenCodeMessage(json({ ...openCodeMessage(), cost: 0.01 }))?.reportedCostUsd).toBe(
    0.01,
  );
  expect(parseOpenCodeMessage(json({ ...openCodeMessage(), role: "user" }))).toBeNull();
});

test("OpenCode reads both SQLite schemas, shards and legacy JSON, dedupes, and observes WAL changes", async () => {
  const data = join(root, "opencode");
  await mkdir(join(data, "storage", "message"), { recursive: true });
  const db = new DatabaseSync(join(data, "opencode.db"));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE session_message(id TEXT, session_id TEXT, type TEXT, data TEXT)",
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      "message",
      "session",
      now,
      json(openCodeMessage()),
    );
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?)").run(
      "new-schema",
      "session",
      "assistant",
      json(openCodeMessage("new-schema")),
    );
    await writeFile(join(data, "storage", "message", "message.json"), json(openCodeMessage()));
    await writeFile(
      join(data, "storage", "message", "legacy.json"),
      json(openCodeMessage("legacy")),
    );
    await symlink(data, join(data, "storage", "message", "loop"));
    const shard = new DatabaseSync(join(data, "opencode-work.db"));
    shard.exec("CREATE TABLE message(id TEXT, session_id TEXT, data TEXT)");
    shard
      .prepare("INSERT INTO message VALUES (?, ?, ?)")
      .run("shard", "session", json(openCodeMessage("shard")));
    shard.close();
    const reader = new OpenCodeReader();
    const first = await reader.read([data], 0);
    expect(first.source.status).toBe("ready");
    expect(first.records).toHaveLength(4);
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      "appended",
      "session",
      now,
      json(openCodeMessage("appended")),
    );
    expect((await reader.read([data], 0)).records).toHaveLength(5);
    expect((await reader.read([data], now + 1)).records).toHaveLength(0);
    await rm(join(data, "opencode-work.db"));
    expect((await reader.read([data], 0)).records).toHaveLength(4);
  } finally {
    db.close();
  }
});

function pn(field: number, value: number) {
  const varint = (value: number) => {
    const bytes: number[] = [];
    do {
      const byte = value % 128;
      value = Math.floor(value / 128);
      bytes.push(byte + (value > 0 ? 128 : 0));
    } while (value > 0);
    return bytes;
  };
  return [...varint(field * 8), ...varint(value)];
}
function pb(field: number, bytes: number[]) {
  const encoded = pn(field, bytes.length);
  encoded[0] += 2;
  return [...encoded, ...bytes];
}
const pt = (field: number, text: string) => pb(field, [...Buffer.from(text)]);
test("Antigravity merges generation/step aliases and retries, preserves models, and refreshes WAL snapshots", async () => {
  const db = new DatabaseSync(join(root, "session.db"));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE gen_metadata(idx INTEGER, data BLOB); CREATE TABLE steps(idx INTEGER, metadata BLOB)",
    );
    const usage = [
      ...pn(2, 100),
      ...pn(3, 40),
      ...pn(4, 5),
      ...pn(5, 20),
      ...pn(9, 10),
      ...pt(11, "response"),
    ];
    const time = pn(1, Math.floor(now / 1000));
    const generation = pb(1, [...pb(4, usage), ...pt(19, "Gemini 3 Pro"), ...pb(9, pb(4, time))]);
    const retry = [...pn(1, 1026), ...pn(2, 12), ...pn(3, 3), ...pt(11, "retry")];
    const step = [...pb(9, usage), ...pb(8, time), ...pb(28, pb(2, retry))];
    db.prepare("INSERT INTO gen_metadata VALUES (?,?)").run(0, new Uint8Array(generation));
    db.prepare("INSERT INTO steps VALUES (?,?)").run(0, new Uint8Array(step));
    const reader = new AntigravityReader();
    let result = await reader.read([root], 0);
    expect(result.source.status).toBe("ready");
    expect(result.records).toHaveLength(2);
    expect(result.records.find((r) => r.model === "gemini-3-pro")?.totals).toEqual({
      uncachedInputTokens: 100,
      cachedInputTokens: 20,
      cacheCreationTokens: 5,
      outputTokens: 40,
      reasoningTokens: 10,
    });
    expect(
      result.records.find((r) => r.model === "claude-opus-4-6")?.totals.uncachedInputTokens,
    ).toBe(12);
    db.prepare("INSERT INTO steps VALUES (?,?)").run(
      1,
      new Uint8Array(pb(9, [...pn(2, 7), ...pt(11, "next")])),
    );
    result = await reader.read([root], 0);
    expect(result.records).toHaveLength(3);
    await copyFile(join(root, "session.db"), join(root, "unsupported.db"));
    await writeFile(join(root, "invalid.db"), "invalid database");
    expect((await reader.read([root], 0)).source.status).toBe("partial");
  } finally {
    db.close();
  }
});

test("Antigravity joins bridged aliases and chooses the better timestamp across database copies", async () => {
  const db = new DatabaseSync(join(root, "bridge.db"));
  db.exec(
    "CREATE TABLE gen_metadata(idx INTEGER, data BLOB); CREATE TABLE steps(idx INTEGER, metadata BLOB)",
  );
  db.prepare("INSERT INTO steps VALUES (?,?)").run(
    0,
    new Uint8Array(pb(9, [...pn(2, 100), ...pt(11, "response")])),
  );
  db.prepare("INSERT INTO steps VALUES (?,?)").run(
    1,
    new Uint8Array(pb(9, [...pn(3, 40), ...pt(12, "provider")])),
  );
  db.prepare("INSERT INTO gen_metadata VALUES (?,?)").run(
    0,
    new Uint8Array(
      pb(1, [
        ...pb(4, [...pt(11, "response"), ...pt(12, "provider"), ...pn(2, 80)]),
        ...pt(19, "Claude Opus 4.6"),
        ...pb(9, pb(4, pn(1, Math.floor(now / 1000)))),
      ]),
    ),
  );
  db.close();
  await copyFile(join(root, "bridge.db"), join(root, "copy.db"));
  const result = await new AntigravityReader().read([root], 0);
  expect(result.records).toHaveLength(1);
  expect(result.records[0]).toMatchObject({
    timestampMs: Math.floor(now / 1000) * 1000,
    totals: { uncachedInputTokens: 100, outputTokens: 40 },
  });
});

test("Cursor uses only its dashboard endpoint, preserves repeated billed events and converts cents", async () => {
  const fetchApi = vi
    .fn<CursorFetch>()
    .mockResolvedValue(
      response({ totalUsageEventsCount: 2, usageEventsDisplay: [cursorEvent(), cursorEvent()] }),
    );
  const result = await readCursorAccountUsage(cursorToken(), 0, now + 1, fetchApi);
  expect(result.records).toHaveLength(2);
  expect(new Set(result.records.map((r) => r.dedupeKey)).size).toBe(2);
  expect(result.records[0]).toMatchObject({ reportedCostUsd: 0.005, rateModel: "xai/grok-4" });
  expect(fetchApi).toHaveBeenCalledWith(
    "https://cursor.com/api/dashboard/get-filtered-usage-events",
    expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: expect.objectContaining({ Origin: "https://cursor.com" }),
    }),
  );
  expect(json(result)).not.toContain(cursorToken());
  expect(cursorRateModel("cursor-claude-sonnet-4-6-thinking-high-fast")).toBe("claude-sonnet-4-6");
});

test("Cursor reconciles overlapping pages, rejects incomplete counts, and never returns partial totals on auth failure", async () => {
  const events = Array.from({ length: 1000 }, (_, i) => cursorEvent(i));
  const fetchApi = vi
    .fn<CursorFetch>()
    .mockResolvedValueOnce(response({ totalUsageEventsCount: 1001, usageEventsDisplay: events }))
    .mockResolvedValueOnce(
      response({
        totalUsageEventsCount: 1001,
        usageEventsDisplay: [events[999], cursorEvent(1000)],
      }),
    );
  expect((await readCursorAccountUsage(cursorToken(), 0, now + 1, fetchApi)).records).toHaveLength(
    1001,
  );
  fetchApi
    .mockReset()
    .mockResolvedValue(
      response({ totalUsageEventsCount: 10, usageEventsDisplay: [cursorEvent()] }),
    );
  await expect(readCursorAccountUsage(cursorToken(), 0, now + 1, fetchApi)).rejects.toThrow(
    "Incomplete",
  );
  fetchApi
    .mockReset()
    .mockResolvedValueOnce(response({ totalUsageEventsCount: 1001, usageEventsDisplay: events }))
    .mockResolvedValueOnce(response({}, 401));
  await expect(readCursorAccountUsage(cursorToken(), 0, now + 1, fetchApi)).rejects.toThrow(
    "Sign in",
  );
  fetchApi.mockReset().mockResolvedValue(
    response({
      totalUsageEventsCount: 1,
      usageEventsDisplay: [{ ...cursorEvent(), tokenUsage: { inputTokens: -1 } }],
    }),
  );
  await expect(readCursorAccountUsage(cursorToken(), 0, now + 1, fetchApi)).rejects.toThrow(
    "Invalid account usage totals",
  );
});

test("Cursor dedupes account logins, caches briefly, forces refresh, and drops totals after logout", async () => {
  const auth = join(root, "auth.json"),
    copy = join(root, "copy.json");
  await writeFile(auth, json({ accessToken: cursorToken() }));
  await copyFile(auth, copy);
  const settings = usageSettings.schema.parse({ cursorAuthFiles: [auth, copy] });
  const fetchApi = vi
    .fn<CursorFetch>()
    .mockResolvedValue(response({ totalUsageEventsCount: 1, usageEventsDisplay: [cursorEvent()] }));
  const reader = new CursorReader(fetchApi);
  expect((await reader.read(settings, 0)).records).toHaveLength(1);
  expect((await reader.read(settings, 0)).records).toHaveLength(1);
  expect(fetchApi).toHaveBeenCalledOnce();
  await reader.read(settings, 0, true);
  expect(fetchApi).toHaveBeenCalledTimes(2);
  await rm(auth);
  await rm(copy);
  expect((await reader.read(settings, 0)).records).toHaveLength(0);
  expect(fetchApi).toHaveBeenCalledTimes(2);
});

test("a large Cursor account survives pagination, cached reads and the combined history scan", async () => {
  const auth = join(root, "large-account.json");
  await writeFile(auth, json({ accessToken: cursorToken() }));
  const settings = usageSettings.schema.parse({ cursorAuthFiles: [auth] });
  const total = 150_001;
  const fetchApi = vi.fn<CursorFetch>().mockImplementation(async (_url, options) => {
    const { page } = JSON.parse(options.body) as { page: number };
    const start = (page - 1) * 1000;
    return response({
      totalUsageEventsCount: total,
      usageEventsDisplay: Array.from({ length: Math.min(1000, total - start) }, (_, i) =>
        cursorEvent(start + i),
      ),
    });
  });
  const reader = new HistoryReader(new CursorReader(fetchApi));
  const first = await reader.read(settings);
  expect(first.sources.find((s) => s.provider === "cursor")).toMatchObject({
    status: "ready",
    records: total,
  });
  expect(first.records).toHaveLength(total);
  expect(new Set(first.records.map((r) => r.dedupeKey)).size).toBe(total);
  expect(fetchApi).toHaveBeenCalledTimes(151);
  const cached = await reader.read(settings);
  expect(cached.records).toHaveLength(total);
  expect(fetchApi).toHaveBeenCalledTimes(151);
});

test("Cursor failed refreshes discard stale success and are throttled until explicitly retried", async () => {
  const auth = join(root, "auth.json");
  await writeFile(auth, json({ accessToken: cursorToken() }));
  const settings = usageSettings.schema.parse({ cursorAuthFiles: [auth] });
  const fetchApi = vi
    .fn<CursorFetch>()
    .mockResolvedValue(response({ totalUsageEventsCount: 1, usageEventsDisplay: [cursorEvent()] }));
  const reader = new CursorReader(fetchApi);
  expect((await reader.read(settings, 0)).records).toHaveLength(1);
  fetchApi.mockResolvedValue(response({}, 401));
  const failed = await reader.read(settings, 0, true);
  expect(failed.source.status).toBe("partial");
  expect(failed.records).toEqual([]);
  expect((await reader.read(settings, 0)).records).toEqual([]);
  expect(fetchApi).toHaveBeenCalledTimes(2);
  fetchApi.mockResolvedValue(
    response({ totalUsageEventsCount: 1, usageEventsDisplay: [cursorEvent()] }),
  );
  expect((await reader.read(settings, 0, true)).records).toHaveLength(1);
});

test("HistoryReader discovers all sources, skips unrelated Grok logs, and dedupes Pi forks", async () => {
  const sessions = join(process.env.GROK_HOME!, "sessions", "one");
  await mkdir(sessions, { recursive: true });
  const turn = {
    timestamp: now,
    params: {
      sessionId: "grok",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "prompt",
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    },
  };
  await writeFile(join(sessions, "updates.jsonl"), json(turn) + "\n");
  await writeFile(join(sessions, "chat_history.jsonl"), json(turn) + "\n");
  const pi = process.env.PI_CODING_AGENT_SESSION_DIR!;
  await mkdir(pi, { recursive: true });
  await writeFile(
    join(pi, "one.jsonl"),
    [json({ type: "session", id: "pi-session" }), json(piMessage())].join("\n"),
  );
  await copyFile(join(pi, "one.jsonl"), join(pi, "fork.jsonl"));
  const fetchApi = vi.fn<CursorFetch>();
  const result = await new HistoryReader(new CursorReader(fetchApi)).read(
    usageSettings.schema.parse({}),
  );
  expect(new Set(result.sources.map((s) => s.provider))).toEqual(new Set(historyProviders));
  expect(result.records.map((r) => r.provider).sort()).toEqual(["grok", "pi"]);
  expect(result.sources.find((s) => s.provider === "grok")?.files).toBe(1);
  expect(result.sources.find((s) => s.provider === "cursor")?.status).toBe("missing");
  expect(fetchApi).not.toHaveBeenCalled();
});

test("all seven original provider formats reach the summary RPC without exposing credentials or messages", async () => {
  const codex = join(process.env.CODEX_HOME!, "sessions");
  const claude = join(process.env.CLAUDE_CONFIG_DIR!, "projects");
  const grok = join(process.env.GROK_HOME!, "sessions");
  const pi = process.env.PI_CODING_AGENT_SESSION_DIR!;
  const opencode = process.env.OPENCODE_DATA_DIR!;
  const antigravity = process.env.ANTIGRAVITY_DATA_DIR!;
  for (const directory of [codex, claude, grok, pi, opencode, antigravity])
    await mkdir(directory, { recursive: true });
  await writeFile(
    join(codex, "session.jsonl"),
    [
      { type: "session_meta", timestamp: stamp, payload: { id: "codex-session" } },
      { type: "turn_context", payload: { model: "gpt-5" } },
      {
        type: "event_msg",
        timestamp: stamp,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
            total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          },
        },
      },
    ]
      .map(json)
      .join("\n"),
  );
  await writeFile(
    join(claude, "session.jsonl"),
    json({
      type: "assistant",
      timestamp: stamp,
      sessionId: "claude-session",
      message: {
        id: "claude-message",
        model: "claude-sonnet-4-6",
        content: "private-transcript-marker",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
  );
  await writeFile(
    join(grok, "updates.jsonl"),
    json({
      timestamp: now,
      params: {
        sessionId: "grok",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "turn",
          usage: { inputTokens: 10, outputTokens: 2, costUsdTicks: 100000 },
        },
      },
    }),
  );
  await writeFile(
    join(pi, "session.jsonl"),
    [json({ type: "session", id: "pi-session" }), json(piMessage())].join("\n"),
  );
  const odb = new DatabaseSync(join(opencode, "opencode.db"));
  odb.exec("CREATE TABLE message(id TEXT, session_id TEXT, data TEXT)");
  odb
    .prepare("INSERT INTO message VALUES (?,?,?)")
    .run("open-message", "open-session", json(openCodeMessage()));
  odb.close();
  const adb = new DatabaseSync(join(antigravity, "conversation.db"));
  adb.exec("CREATE TABLE steps(idx INTEGER, metadata BLOB)");
  adb
    .prepare("INSERT INTO steps VALUES (?,?)")
    .run(
      0,
      new Uint8Array([
        ...pb(8, pn(1, Math.floor(now / 1000))),
        ...pb(9, [...pn(1, 1026), ...pn(2, 10), ...pt(11, "response")]),
      ]),
    );
  adb.close();
  const auth = join(root, "cursor-auth.json");
  await writeFile(auth, json({ accessToken: cursorToken() }));
  const settings = usageSettings.schema.parse({ cursorAuthFiles: [auth] });
  const fetchApi = vi
    .fn<CursorFetch>()
    .mockResolvedValue(response({ totalUsageEventsCount: 1, usageEventsDisplay: [cursorEvent()] }));
  const scan = await new HistoryReader(new CursorReader(fetchApi)).read(settings);
  expect(scan.sources.every((source) => source.status === "ready")).toBe(true);
  expect(new Set(scan.records.map((record) => record.provider))).toEqual(new Set(historyProviders));
  const input = { days: 7 as const, timeZone: "UTC", hiddenProviders: [] };
  const summary = summaryRpc.output.parse(
    summarize(scan.records, scan.sources, settings, input, new Date(now + 1)),
  );
  expect(summary.providers).toHaveLength(7);
  expect(summary.totals.tokens).toBe(
    scan.records.reduce((sum, record) => sum + totalTokens(record.totals), 0),
  );
  expect(json(summary)).not.toContain(cursorToken());
  expect(json(summary)).not.toContain("private-transcript-marker");
  expect(
    summarize(
      scan.records,
      scan.sources,
      settings,
      { ...input, hiddenProviders: ["cursor"] },
      new Date(now + 1),
    ).providers,
  ).toHaveLength(6);
});
