import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readTranscript, transcriptSignature, type TranscriptCache } from "./transcript.ts";
import type { UsageRecord } from "./types.ts";
import type { UsageSettings, UsageSummary } from "../shared/usage.ts";
import { environmentPaths, expandHome, roots, sourceState, type SourceScan } from "./source-files";
import { OpenCodeReader } from "./opencode";
import { AntigravityReader } from "./antigravity";
import { CursorReader } from "./cursor";

type Source = UsageSummary["sources"][number];
type Cached = TranscriptCache;
type Scan = { records: UsageRecord[]; sources: Source[] };
export { expandHome } from "./source-files";
export class HistoryReader {
  private cache = new Map<string, Cached>();
  private pending: Promise<Scan> | null = null;
  private configuration = "";
  private opencode = new OpenCodeReader();
  private antigravity = new AntigravityReader();
  constructor(private cursor = new CursorReader()) {}

  async read(settings: UsageSettings, refresh = false): Promise<Scan> {
    // Serialize scans even if source settings change during a refresh.
    const configuration = JSON.stringify([settings, refresh]);
    if (this.pending) {
      if (configuration === this.configuration) return this.pending;
      await this.pending.catch(() => {});
      return this.read(settings, refresh);
    }
    this.configuration = configuration;
    this.pending = this.scan(settings, refresh);
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async scan(settings: UsageSettings, refresh: boolean) {
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
                  : !entry.name.endsWith(".jsonl"))
              )
                continue;
              let canonicalFile: string | null = null;
              try {
                const canonical = await realpath(file);
                canonicalFile = canonical;
                if (activeFiles.has(canonical)) continue;
                activeFiles.add(canonical);
                const info = await stat(canonical);
                source.files++;
                const signature = transcriptSignature(info);
                let cached = this.cache.get(canonical);
                if (cached?.signature !== signature || cached.provider !== group.provider) {
                  cached = await readTranscript(canonical, group.provider, cached);
                  this.cache.set(canonical, cached);
                }
                malformed += cached.malformed;
                collect(cached);
              } catch {
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
    const cutoff = Date.now() - 92 * 86_400_000;
    const readSource = async (
      provider: string,
      paths: string[],
      read: (paths: string[]) => Promise<SourceScan>,
    ) => {
      let scanned: SourceScan;
      try {
        scanned = await read(await roots(paths));
      } catch {
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
      records.push(...scanned.records);
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
    return { records, sources };
  }
}
