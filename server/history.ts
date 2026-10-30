import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  readTranscript,
  transcriptSignature,
  type TranscriptCache,
  type TranscriptReadOptions,
} from "./transcript.ts";
import type { UsageRecord } from "./types.ts";
import type { UsageSettings, UsageSummary } from "../shared/usage.ts";
import { environmentPaths, expandHome, roots, sourceState, type SourceScan } from "./source-files";
import { OpenCodeReader } from "./opencode";
import { AntigravityReader } from "./antigravity";
import { CursorReader } from "./cursor";

type Source = UsageSummary["sources"][number];
type Cached = TranscriptCache;
export type HistoryScan = { records: UsageRecord[]; sources: Source[]; deferredKey: string };
export { expandHome } from "./source-files";
export class HistoryReader {
  private pending: Promise<HistoryScan> | null = null;
  private configuration = "";
  private opencode = new OpenCodeReader();
  private antigravity = new AntigravityReader();
  constructor(
    private cursor = new CursorReader(),
    private cache = new Map<string, Cached>(),
    private options: TranscriptReadOptions = {},
  ) {}

  async read(settings: UsageSettings, refresh = false, sinceMs?: number): Promise<HistoryScan> {
    this.options.signal?.throwIfAborted();
    // Serialize scans even if source settings change during a refresh.
    const configuration = JSON.stringify([settings, refresh, sinceMs]);
    if (this.pending) {
      if (configuration === this.configuration) return this.pending;
      await this.pending.catch(() => {});
      return this.read(settings, refresh, sinceMs);
    }
    this.configuration = configuration;
    this.pending = this.scan(settings, refresh, sinceMs);
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async scan(settings: UsageSettings, refresh: boolean, sinceMs?: number) {
    this.options.signal?.throwIfAborted();
    const groups = [
      {
        provider: "codex",
        homes: [process.env.CODEX_HOME || join(homedir(), ".codex"), ...settings.codexHomes],
        subdirs: ["sessions", "archived_sessions"],
      },
      {
        provider: "claude",
        homes: [
          process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
          ...settings.claudeHomes,
        ],
        subdirs: ["projects"],
      },
      {
        provider: "grok",
        homes: [process.env.GROK_HOME || join(homedir(), ".grok"), ...settings.grokHomes],
        subdirs: ["sessions"],
        fileName: "updates.jsonl",
      },
      {
        provider: "pi",
        homes: [
          process.env.PI_CODING_AGENT_SESSION_DIR ||
            join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions"),
          ...settings.piSessionDirs,
        ],
        subdirs: [""],
      },
    ];
    const sources: Source[] = [];
    const records: UsageRecord[] = [];
    const seen = new Set<string>();
    const visited = new Set<string>();
    const activeFiles = new Set<string>();
    const deferred: string[] = [];
    for (const group of groups) {
      const source: Source = { provider: group.provider, files: 0, records: 0, status: "missing" };
      let failed = 0;
      let malformed = 0;
      const collect = (cached: Cached) => {
        const occurrences = new Map<string, number>();
        for (const record of [...cached.records, ...cached.tailRecords]) {
          const identity =
            record.dedupeKey ??
            `${record.sessionId}:${record.timestampMs}:${record.model}:${JSON.stringify(record.totals)}`;
          const occurrence = (occurrences.get(identity) ?? 0) + 1;
          occurrences.set(identity, occurrence);
          const key =
            group.provider + ":" + identity + (record.dedupeKey === null ? ":" + occurrence : "");
          if (seen.has(key)) continue;
          seen.add(key);
          records.push(record);
          source.records++;
        }
      };
      for (const home of group.homes) {
        const expanded = expandHome(home.trim());
        if (!isAbsolute(expanded)) {
          failed++;
          continue;
        }
        for (const subdir of group.subdirs) {
          const root = join(expanded, subdir);
          const walk = async (directory: string): Promise<void> => {
            this.options.signal?.throwIfAborted();
            let entries;
            try {
              const canonical = await realpath(directory);
              const key = group.provider + ":" + canonical;
              if (visited.has(key)) return;
              visited.add(key);
              entries = await readdir(canonical, { withFileTypes: true });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed++;
              return;
            }
            for (const entry of entries) {
              const file = join(directory, entry.name);
              if (entry.isDirectory()) {
                await walk(file);
                continue;
              }
              // Never traverse symlinks or unrelated files such as credential stores.
              if (
                !entry.isFile() ||
                ("fileName" in group
                  ? entry.name !== group.fileName
                  : !entry.name.endsWith(".jsonl") &&
                    !(group.provider === "codex" && entry.name.endsWith(".jsonl.zst")))
              )
                continue;
              let canonicalFile: string | null = null;
              try {
                await this.options.beforeRead?.();
                this.options.signal?.throwIfAborted();
                const canonical = await realpath(file);
                canonicalFile = canonical;
                if (activeFiles.has(canonical)) continue;
                activeFiles.add(canonical);
                const info = await stat(canonical);
                source.files++;
                const signature = transcriptSignature(info);
                let cached = this.cache.get(canonical);
                if (cached?.signature !== signature || cached.provider !== group.provider) {
                  // Old mtimes only prioritize work. A full background pass verifies skipped
                  // files too, including restored files whose usage is newer than their mtime.
                  if (sinceMs !== undefined && info.mtimeMs < sinceMs) {
                    deferred.push(`${group.provider}:${canonical}:${signature}`);
                    if (cached?.provider === group.provider) collect(cached);
                    continue;
                  }
                  const previous = cached;
                  const parsed = await readTranscript(
                    canonical,
                    group.provider,
                    cached,
                    this.options,
                  );
                  // A foreground scan may have updated this file while the background reader
                  // was paused. Never replace that result with a slower, earlier read.
                  const current = this.cache.get(canonical);
                  cached =
                    current !== previous && current?.provider === group.provider ? current : parsed;
                  this.cache.set(canonical, cached);
                }
                malformed += cached.malformed;
                collect(cached);
              } catch {
                this.options.signal?.throwIfAborted();
                failed++;
                const previous = this.cache.get(canonicalFile ?? file);
                if (previous) collect(previous);
              }
            }
          };
          await walk(root);
        }
      }
      source.status = failed || malformed ? "partial" : source.files ? "ready" : "missing";
      if (failed)
        source.message = `${failed} history locations could not be read. Check source permissions and configured homes.`;
      else if (malformed) source.message = `${malformed} invalid usage records were excluded.`;
      sources.push(source);
    }
    for (const file of this.cache.keys()) if (!activeFiles.has(file)) this.cache.delete(file);
    const cutoff = sinceMs ?? Date.now() - 92 * 86_400_000;
    const readSource = async (
      provider: string,
      paths: string[],
      read: (paths: string[]) => Promise<SourceScan>,
    ) => {
      let scanned: SourceScan;
      try {
        await this.options.beforeRead?.();
        this.options.signal?.throwIfAborted();
        scanned = await read(await roots(paths));
        this.options.signal?.throwIfAborted();
      } catch {
        this.options.signal?.throwIfAborted();
        scanned = {
          records: [],
          source: {
            ...sourceState(provider),
            status: "partial",
            message: `${provider} history could not be read. Check source paths and permissions.`,
          },
        };
      }
      sources.push(scanned.source);
      for (const record of scanned.records) records.push(record);
    };
    const opencodeEnv = environmentPaths("OPENCODE_DATA_DIR");
    const xdgData = process.env.XDG_DATA_HOME;
    await readSource(
      "opencode",
      [
        ...(opencodeEnv.length
          ? opencodeEnv
          : [
              join(
                xdgData && isAbsolute(xdgData) ? xdgData : join(homedir(), ".local", "share"),
                "opencode",
              ),
            ]),
        ...settings.opencodeDataDirs,
      ],
      (paths) => this.opencode.read(paths, cutoff),
    );
    const antigravityEnv = environmentPaths("ANTIGRAVITY_DATA_DIR");
    await readSource(
      "antigravity",
      [
        ...(antigravityEnv.length
          ? antigravityEnv
          : [
              ...["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"].map(
                (name) => join(homedir(), ".gemini", name),
              ),
              join(homedir(), ".config", "antigravity"),
            ]),
        ...settings.antigravityDataDirs,
      ],
      (paths) => this.antigravity.read(paths, cutoff),
    );
    await readSource("cursor", [], () => this.cursor.read(settings, cutoff, refresh));
    return { records, sources, deferredKey: JSON.stringify(deferred.sort()) };
  }
}
