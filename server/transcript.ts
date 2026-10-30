import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename } from "node:path";
import * as zlib from "node:zlib";
import { initialCodexScanState, parseCodexLine, type CodexScanState } from "./codex.ts";
import { parseClaudeLine } from "./claude.ts";
import { parseGrokLine } from "./grok";
import { parsePiLine } from "./pi";
import type { UsageRecord } from "./types.ts";

export type TranscriptCache = {
  signature: string;
  provider: string;
  identity: string;
  size: number;
  position: number;
  head: Buffer;
  guard: Buffer;
  state: CodexScanState;
  piState: { sessionId: string };
  records: UsageRecord[];
  tailRecords: UsageRecord[];
  exceptions: number;
  malformed: number;
};

const GUARD_BYTES = 256;
const CODEX_MARKERS = [
  "token_count",
  "turn_context",
  "session_meta",
  "thread_settings_applied",
].map((marker) => Buffer.from('"' + marker + '"'));
const CLAUDE_MARKER = Buffer.from('"usage"');
export type TranscriptReadOptions = {
  signal?: AbortSignal;
  beforeRead?: () => Promise<void>;
};
const identity = (info: Stats) => `${info.dev}:${info.ino}:${info.birthtimeMs}`;
export const transcriptSignature = (info: Stats) =>
  `${identity(info)}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

async function bytes(file: FileHandle, position: number, length: number) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await file.read(buffer, offset, length - offset, position + offset);
    if (read.bytesRead === 0) throw new Error("Transcript changed during scan");
    offset += read.bytesRead;
  }
  return buffer;
}

// Resume only from complete JSONL lines. A valid final line without a newline is
// displayed provisionally, then replaced when more bytes arrive.
export async function readTranscript(
  path: string,
  provider: string,
  previous?: TranscriptCache,
  options: TranscriptReadOptions = {},
): Promise<TranscriptCache> {
  options.signal?.throwIfAborted();
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    const compressed = provider === "codex" && path.endsWith(".jsonl.zst");
    let resume =
      !compressed &&
      previous?.provider === provider &&
      previous.identity === identity(info) &&
      info.size > previous.size;
    if (resume && previous) {
      const head = await bytes(file, 0, previous.head.length);
      const guard = await bytes(
        file,
        previous.position - previous.guard.length,
        previous.guard.length,
      );
      resume = head.equals(previous.head) && guard.equals(previous.guard);
    }
    const base = resume ? previous : undefined;
    const records = base ? [...base.records] : [];
    const state = base ? structuredClone(base.state) : initialCodexScanState();
    const piState = base ? structuredClone(base.piState) : { sessionId: "" };
    let position = base?.position ?? 0;
    let exceptions = base?.exceptions ?? 0;
    const fragments: Buffer[] = [];
    let pendingLength = 0;
    const cutoff = Date.now() - 92 * 86_400_000;
    const parse = (line: Buffer, scanState: CodexScanState, pi: { sessionId: string }) => {
      if (provider === "codex" && !CODEX_MARKERS.some((marker) => line.includes(marker)))
        return { records: [], exceptions: 0 };
      if (provider === "claude" && !line.includes(CLAUDE_MARKER))
        return { records: [], exceptions: 0 };
      try {
        const text = line.toString("utf8");
        let parsed: readonly UsageRecord[];
        if (provider === "grok") parsed = parseGrokLine(text);
        else if (provider === "pi") parsed = parsePiLine(text, pi);
        else {
          const record =
            provider === "codex" ? parseCodexLine(text, scanState) : parseClaudeLine(text);
          parsed = record ? [record] : [];
        }
        const records = parsed.filter((record) => record.timestampMs >= cutoff);
        for (const record of records)
          if (!record.sessionId) record.sessionId = basename(path.replace(/\.zst$/, ""), ".jsonl");
        return { records, exceptions: 0 };
      } catch {
        return { records: [], exceptions: 1 };
      }
    };
    if (position < info.size) {
      const input = createReadStream(path, {
        start: position,
        end: info.size - 1,
        signal: options.signal,
      });
      // Compressed rollouts are read from the beginning when their fingerprint changes.
      // Byte offsets in the decompressed JSONL cannot be used to seek the compressed file.
      let stream: AsyncIterable<Buffer> & { destroy(): void } = input;
      try {
        if (compressed) {
          if (typeof zlib.createZstdDecompress !== "function")
            throw new Error(
              "Reading compressed Codex history requires Node.js with Zstandard support",
            );
          const decoder = zlib.createZstdDecompress();
          input.on("error", (error) => decoder.destroy(error));
          stream = input.pipe(decoder);
        }
        for await (const chunk of stream) {
          await options.beforeRead?.();
          options.signal?.throwIfAborted();
          let start = 0;
          for (let end = chunk.indexOf(10, start); end !== -1; end = chunk.indexOf(10, start)) {
            const part = chunk.subarray(start, end);
            const length = pendingLength + part.length;
            // Join a split line once, rather than re-copying its entire prefix for every chunk.
            if (fragments.length) fragments.push(part);
            const line = fragments.length ? Buffer.concat(fragments, length) : part;
            const parsed = parse(line, state, piState);
            for (const record of parsed.records) records.push(record);
            exceptions += parsed.exceptions;
            position += length + 1;
            fragments.length = 0;
            pendingLength = 0;
            start = end + 1;
          }
          if (start < chunk.length) {
            const part = chunk.subarray(start);
            fragments.push(part);
            pendingLength += part.length;
          }
        }
      } finally {
        input.destroy();
        stream.destroy();
      }
    }
    const tailState = structuredClone(state);
    const tail = pendingLength
      ? parse(Buffer.concat(fragments, pendingLength), tailState, structuredClone(piState))
      : { records: [], exceptions: 0 };
    const head = compressed
      ? Buffer.alloc(0)
      : await bytes(file, 0, Math.min(position, GUARD_BYTES));
    const guard = compressed
      ? Buffer.alloc(0)
      : await bytes(file, Math.max(0, position - GUARD_BYTES), Math.min(position, GUARD_BYTES));
    return {
      signature: transcriptSignature(info),
      provider,
      identity: identity(info),
      size: info.size,
      position,
      head,
      guard,
      state,
      piState,
      records,
      tailRecords: tail.records,
      exceptions,
      malformed: exceptions + tail.exceptions + tailState.malformedRecords,
    };
  } finally {
    await file.close();
  }
}
