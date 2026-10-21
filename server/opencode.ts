// Adapted from T3 Code (MIT). See ../THIRD_PARTY_NOTICES.md.
import { totalTokens, type UsageRecord } from "./types";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  databaseFingerprint,
  missing,
  openUsageDatabase,
  sourceState,
  walkFiles,
  yieldScan,
  type SourceScan,
} from "./source-files";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseOpenCodeMessage(
  source: string,
  fallback: {
    readonly id?: string;
    readonly sessionId?: string;
    readonly timestampMs?: number;
  } = {},
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const message = object(parsed);
  if (message.role !== undefined && message.role !== "assistant") return null;
  const usage = object(message.tokens);
  const cache = object(usage.cache);
  const modelReference = object(message.model);
  const model = text(modelReference.id) || text(modelReference.modelID) || text(message.modelID);
  const timestampMs = object(message.time).created ?? fallback.timestampMs;
  if (!model || typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return null;
  const reasoningTokens = tokens(usage.reasoning);
  const totals = {
    uncachedInputTokens: tokens(usage.input),
    cachedInputTokens: tokens(cache.read),
    cacheCreationTokens: tokens(cache.write),
    outputTokens: tokens(usage.output) + reasoningTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;
  const id = fallback.id || text(message.id);
  const cost = message.cost;
  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId: fallback.sessionId || text(message.sessionID),
    totals,
    // OpenCode writes zero for models without a known rate, including paid
    // subscription models. Let the shared price table estimate those records.
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null,
    speed: "standard",
    dedupeKey: id ? `opencode:${id}` : null,
  };
}

export class OpenCodeReader {
  private cache = new Map<
    string,
    { fingerprint: string; sinceMs: number; records: UsageRecord[] }
  >();
  async read(roots: string[], sinceMs: number): Promise<SourceScan> {
    const source = sourceState("opencode"),
      records: UsageRecord[] = [];
    const seen = new Set<string>(),
      active = new Set<string>();
    let errors = 0;
    const append = (record: UsageRecord | null) => {
      if (!record || record.timestampMs < sinceMs) return;
      if (record.dedupeKey && seen.has(record.dedupeKey)) return;
      if (record.dedupeKey) seen.add(record.dedupeKey);
      records.push(record);
    };
    for (const root of roots) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if (!missing(error)) errors++;
        continue;
      }
      const databases = entries
        .filter((e) => e.isFile() && /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(e.name))
        .sort((a, b) =>
          a.name === "opencode.db"
            ? -1
            : b.name === "opencode.db"
              ? 1
              : a.name.localeCompare(b.name),
        );
      for (const entry of databases) {
        const path = join(root, entry.name);
        active.add(path);
        source.files++;
        try {
          const fingerprint = await databaseFingerprint(path);
          const cached = this.cache.get(path);
          if (cached?.fingerprint === fingerprint && cached.sinceMs <= sinceMs) {
            cached.records.forEach(append);
            continue;
          }
          const rows: UsageRecord[] = [];
          const db = await openUsageDatabase(path);
          try {
            db.exec("BEGIN");
            const tables = new Set(
              db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all()
                .map((r) => r.name),
            );
            if (!tables.has("message") && !tables.has("session_message"))
              throw new Error("Unsupported OpenCode database");
            for (const table of ["message", "session_message"]) {
              if (!tables.has(table)) continue;
              const columns = new Set(
                db
                  .prepare(`PRAGMA table_info(${table})`)
                  .all()
                  .map((r) => r.name),
              );
              const time = columns.has("time_created") ? "time_created" : "NULL";
              const range = db
                .prepare(`SELECT MIN(rowid) AS first, MAX(rowid) AS last FROM ${table}`)
                .get();
              if (typeof range?.first !== "number" || typeof range.last !== "number") continue;
              const query = db.prepare(
                `SELECT id, session_id, data, ${time} AS created FROM ${table} WHERE rowid > ? AND rowid <= ? ${time === "NULL" ? "" : "AND time_created >= ?"} ${table === "session_message" ? "AND type = 'assistant'" : ""} ORDER BY rowid`,
              );
              for (let after = range.first - 1; after < range.last; after += 64) {
                for (const row of query.all(
                  after,
                  Math.min(after + 64, range.last),
                  ...(time === "NULL" ? [] : [sinceMs]),
                )) {
                  const record = parseOpenCodeMessage(text(row.data), {
                    id: text(row.id),
                    sessionId: text(row.session_id),
                    timestampMs: typeof row.created === "number" ? row.created : undefined,
                  });
                  if (record) rows.push(record);
                }
                await yieldScan();
              }
            }
            db.exec("COMMIT");
          } finally {
            db.close();
          }
          // Never cache a snapshot under a fingerprint observed after an intervening write.
          if ((await databaseFingerprint(path)) === fingerprint)
            this.cache.set(path, { fingerprint, sinceMs, records: rows });
          rows.forEach(append);
        } catch {
          errors++;
        }
      }
      await walkFiles(
        join(root, "storage", "message"),
        (name) => name.endsWith(".json"),
        async (path) => {
          source.files++;
          if (seen.has(`opencode:${basename(path, ".json")}`)) return;
          append(
            parseOpenCodeMessage(await readFile(path, "utf8"), { id: basename(path, ".json") }),
          );
        },
        () => {
          errors++;
        },
      );
    }
    for (const key of this.cache.keys()) if (!active.has(key)) this.cache.delete(key);
    source.records = records.length;
    source.status = errors ? "partial" : source.files ? "ready" : "missing";
    if (errors)
      source.message =
        "Some OpenCode history could not be read. SQLite sources require node:sqlite on the host.";
    return { records, source };
  }
}
