import { afterEach, expect, test, vi } from "vite-plus/test";
import { createReadStream } from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscript } from "../server/transcript";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const stamp = new Date().toISOString();
const meta = JSON.stringify({ type: "session_meta", timestamp: stamp, payload: { id: "session" } });
const context = JSON.stringify({ type: "turn_context", payload: { model: "gpt-5" } });
const usage = (n: number) => ({
  input_tokens: 100 * n,
  output_tokens: 10 * n,
  total_tokens: 110 * n,
});
const event = (n: number) =>
  JSON.stringify({
    type: "event_msg",
    timestamp: stamp,
    payload: {
      type: "token_count",
      info: { last_token_usage: usage(1), total_token_usage: usage(n) },
    },
  });
async function fixture(content: string) {
  const root = await mkdtemp(join(tmpdir(), "paseo-incremental-"));
  roots.push(root);
  const file = join(root, "rollout.jsonl");
  await writeFile(file, content);
  return file;
}
const records = (cache: Awaited<ReturnType<typeof readTranscript>>) => [
  ...cache.records,
  ...cache.tailRecords,
];

test("a growing rollout reads only appended bytes and preserves cumulative-counter state", async () => {
  const initial = [meta, context, event(1)].join("\r\n") + "\r\n";
  const file = await fixture(initial);
  const first = await readTranscript(file, "codex");
  await appendFile(file, event(2) + "\n");
  const next = await readTranscript(file, "codex", first);
  expect(vi.mocked(createReadStream).mock.calls[1]?.[1]).toMatchObject({
    start: Buffer.byteLength(initial),
  });
  expect(records(next)).toHaveLength(2);
  expect(next.malformed).toBe(0);
  const cold = await readTranscript(file, "codex");
  expect(records(next)).toEqual(records(cold));
});

test("an unfinished UTF-8 line is resumed, and a valid unterminated event is never counted twice", async () => {
  const initial = [meta, context, event(1)].join("\n") + "\n";
  const file = await fixture(initial);
  const partial = Buffer.from(JSON.stringify({ type: "response_item", text: "café" }));
  const split = partial.indexOf(Buffer.from("é")) + 1;
  await appendFile(file, partial.subarray(0, split));
  const first = await readTranscript(file, "codex");
  expect(records(first)).toHaveLength(1);
  await appendFile(file, Buffer.concat([partial.subarray(split), Buffer.from("\n" + event(2))]));
  const second = await readTranscript(file, "codex", first);
  expect(records(second)).toHaveLength(2);
  expect(second.tailRecords).toHaveLength(1);
  await appendFile(file, "\n" + event(3) + "\n");
  const third = await readTranscript(file, "codex", second);
  expect(third.tailRecords).toHaveLength(0);
  expect(records(third)).toHaveLength(3);
  expect(records(third)).toEqual(records(await readTranscript(file, "codex")));
});

test("truncated, replaced, or rewritten growing files restart instead of retaining old usage", async () => {
  const file = await fixture([meta, context, event(1), event(2)].join("\n") + "\n");
  let cache = await readTranscript(file, "codex");
  await writeFile(file, [meta, context, event(1)].join("\n") + "\n");
  cache = await readTranscript(file, "codex", cache);
  expect(records(cache)).toHaveLength(1);
  const changedMeta = meta.replace('"session"', '"changed"');
  await writeFile(file, [changedMeta, context, event(1), event(2)].join("\n") + "\n");
  cache = await readTranscript(file, "codex", cache);
  expect(records(cache)).toHaveLength(2);
  expect(records(cache).every((r) => r.sessionId === "changed")).toBe(true);
  await rm(file);
  await writeFile(file, [meta, context, event(1), event(2), event(3)].join("\n") + "\n");
  cache = await readTranscript(file, "codex", cache);
  expect(records(cache)).toHaveLength(3);
  expect(records(cache).every((r) => r.sessionId === "session")).toBe(true);
});

test("Claude append scans preserve unterminated usage and agree with a cold scan", async () => {
  const claude = (id: string) =>
    JSON.stringify({
      type: "assistant",
      timestamp: stamp,
      sessionId: "claude",
      message: { id, model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 5 } },
    });
  const file = await fixture(claude("first"));
  const first = await readTranscript(file, "claude");
  expect(records(first)).toHaveLength(1);
  await appendFile(file, "\n" + claude("second") + "\n");
  const next = await readTranscript(file, "claude", first);
  expect(records(next)).toHaveLength(2);
  expect(records(next)).toEqual(records(await readTranscript(file, "claude")));
});
