import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { UsageRecord } from "./types";
import type { UsageSummary } from "../shared/usage";

export type Source = UsageSummary["sources"][number];
export type SourceScan = { records: UsageRecord[]; source: Source };
export const sourceState = (provider: string): Source => ({
  provider,
  files: 0,
  records: 0,
  status: "missing",
});
export const yieldScan = () => setImmediate();
export const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
export function expandHome(path: string) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}
export async function roots(paths: string[]) {
  const result = new Set<string>();
  for (const path of paths) {
    const expanded = expandHome(path.trim());
    if (!isAbsolute(expanded)) throw new Error("History locations must be absolute or ~/ paths.");
    result.add(await realpath(expanded).catch(() => expanded));
  }
  return [...result];
}
export const environmentPaths = (name: string) =>
  (process.env[name] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

// Deliberately skip symlinks and unrelated files. Callers supply provider-specific roots.
export async function walkFiles(
  root: string,
  accept: (name: string) => boolean,
  onFile: (path: string) => Promise<void>,
  onError: () => void,
) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (!missing(error)) onError();
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(path, accept, onFile, onError);
    else if (entry.isFile() && accept(entry.name)) {
      try {
        await onFile(path);
      } catch {
        onError();
      }
    }
  }
}

export async function databaseFingerprint(path: string) {
  const part = async (file: string) => {
    try {
      const s = await stat(file);
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    } catch (error) {
      if (missing(error)) return "-";
      throw error;
    }
  };
  return `${await part(path)}/${await part(path + "-wal")}`;
}

// Dynamic import keeps JSONL sources usable when a host lacks node:sqlite.
export async function openUsageDatabase(path: string) {
  const moduleName = "node:sqlite";
  const sqlite: typeof import("node:sqlite") = await import(/* @vite-ignore */ moduleName);
  const db = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 100; PRAGMA query_only = ON;");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
