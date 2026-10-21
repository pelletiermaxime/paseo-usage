import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename } from "node:path";
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
): Promise<TranscriptCache> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    let resume =
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
    let pending: Buffer = Buffer.alloc(0);
    const cutoff = Date.now() - 92 * 86_400_000;
    const parse = (line: string, scanState: CodexScanState, pi: { sessionId: string }) => {
      if (
        provider === "codex" &&
        !["token_count", "turn_context", "session_meta", "thread_settings_applied"].some((marker) =>
          line.includes('"' + marker + '"'),
        )
      )
        return { records: [], exceptions: 0 };
      if (provider === "claude" && !line.includes('"usage"')) return { records: [], exceptions: 0 };
      try {
        let parsed: readonly UsageRecord[];
        if (provider === "grok") parsed = parseGrokLine(line);
        else if (provider === "pi") parsed = parsePiLine(line, pi);
        else {
          const record =
            provider === "codex" ? parseCodexLine(line, scanState) : parseClaudeLine(line);
          parsed = record ? [record] : [];
        }
        const records = parsed.filter((record) => record.timestampMs >= cutoff);
        for (const record of records)
          if (!record.sessionId) record.sessionId = basename(path, ".jsonl");
        return { records, exceptions: 0 };
      } catch {
        return { records: [], exceptions: 1 };
      }
    };
    if (position < info.size) {
      const stream = createReadStream(path, {
        start: position,
        end: info.size - 1,
      });
      try {
        for await (const chunk of stream) {
          const buffer: Buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          let start = 0;
          for (let end = buffer.indexOf(10, start); end !== -1; end = buffer.indexOf(10, start)) {
            const parsed = parse(buffer.subarray(start, end).toString("utf8"), state, piState);
            records.push(...parsed.records);
            exceptions += parsed.exceptions;
            position += end - start + 1;
            start = end + 1;
          }
          pending = buffer.subarray(start);
        }
      } finally {
        stream.destroy();
      }
    }
    const tailState = structuredClone(state);
    const tail = pending.length
      ? parse(pending.toString("utf8"), tailState, structuredClone(piState))
      : { records: [], exceptions: 0 };
    const head = await bytes(file, 0, Math.min(position, GUARD_BYTES));
    const guard = await bytes(
      file,
      Math.max(0, position - GUARD_BYTES),
      Math.min(position, GUARD_BYTES),
    );
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
