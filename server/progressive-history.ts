import { setImmediate } from "node:timers/promises";
import { HistoryReader, type HistoryScan } from "./history";
import { CursorReader } from "./cursor";
import type { TranscriptCache } from "./transcript";
import type { UsageSettings } from "../shared/usage";

type Scope = {
  key: string;
  controller: AbortController;
  recent: HistoryReader;
  full: HistoryReader;
  foreground: number;
  waiters: Set<() => void>;
  job: Promise<HistoryScan> | null;
  warmed: boolean;
  attemptedDeferred: string;
  sources: HistoryScan["sources"];
};

// Presentation changes reuse the same source cache and background job.
function sourceKey(settings: UsageSettings) {
  const {
    metric: _metric,
    days: _days,
    hiddenProviders: _hidden,
    prices: _prices,
    modelMappings: _mappings,
    ...sources
  } = settings;
  return JSON.stringify([
    sources,
    process.env.CODEX_HOME,
    process.env.CLAUDE_CONFIG_DIR,
    process.env.GROK_HOME,
    process.env.PI_CODING_AGENT_SESSION_DIR,
    process.env.PI_CODING_AGENT_DIR,
    process.env.OPENCODE_DATA_DIR,
    process.env.ANTIGRAVITY_DATA_DIR,
    process.env.XDG_DATA_HOME,
    process.env.XDG_CONFIG_HOME,
    process.env.AGENT_CLI_CREDENTIAL_STORE,
  ]);
}

async function yieldToForeground(scope: Scope) {
  const signal = scope.controller.signal;
  signal.throwIfAborted();
  while (scope.foreground > 0) {
    signal.throwIfAborted();
    await new Promise<void>((resolve) => {
      const finish = () => {
        scope.waiters.delete(finish);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      scope.waiters.add(finish);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
  signal.throwIfAborted();
}

export class ProgressiveHistoryReader {
  private scope: Scope | null = null;
  private disposed = false;

  private getScope(settings: UsageSettings) {
    if (this.disposed) throw new Error("History reader has been disposed");
    const key = sourceKey(settings);
    if (this.scope?.key === key) return this.scope;
    this.scope?.controller.abort();
    const cache = new Map<string, TranscriptCache>();
    const controller = new AbortController();
    const scope: Scope = {
      key,
      controller,
      recent: new HistoryReader(new CursorReader(), cache, { signal: controller.signal }),
      full: new HistoryReader(new CursorReader(), cache, {
        signal: controller.signal,
        beforeRead: () => yieldToForeground(scope),
      }),
      foreground: 0,
      waiters: new Set(),
      job: null,
      warmed: false,
      attemptedDeferred: "",
      sources: [],
    };
    this.scope = scope;
    return scope;
  }

  private warm(scope: Scope, settings: UsageSettings, refresh: boolean) {
    if (scope.job) return scope.job;
    const job = (async () => {
      // Let the recent response reach its caller before starting older transcript work.
      await setImmediate();
      await yieldToForeground(scope);
      return scope.full.read(settings, refresh);
    })();
    scope.job = job;
    void job
      .then(
        (scan) => {
          scope.sources = scan.sources;
          scope.warmed = true;
        },
        () => {
          scope.warmed = true;
        },
      )
      .finally(() => {
        if (scope.job === job) scope.job = null;
      });
    return job;
  }

  async read(settings: UsageSettings, days: 1 | 7 | 30 | 90, refresh = false) {
    const scope = this.getScope(settings);
    if (days !== 1) {
      // A wide request may await the warm-up, but never locks out recent requests.
      const scan = await this.warm(scope, settings, refresh);
      return { ...scan, historyLoading: false };
    }
    scope.foreground++;
    let scan: HistoryScan;
    try {
      scan = await scope.recent.read(settings, refresh, Date.now() - 86_400_000);
    } finally {
      scope.foreground--;
      if (scope.foreground === 0) for (const finish of scope.waiters) finish();
    }
    scope.controller.signal.throwIfAborted();
    if (
      !scope.warmed ||
      refresh ||
      (scan.deferredKey !== "[]" && scan.deferredKey !== scope.attemptedDeferred)
    ) {
      scope.attemptedDeferred = scan.deferredKey;
      void this.warm(scope, settings, refresh);
    }
    // Preserve diagnostics from a failed older-file read until a later full scan succeeds.
    const sources = scan.sources.map((source) => {
      const previous = scope.sources.find(
        (s) => s.provider === source.provider && s.status === "partial",
      );
      return source.status === "ready" && previous
        ? { ...source, status: previous.status, message: previous.message }
        : source;
    });
    return { ...scan, sources, historyLoading: scope.job !== null };
  }

  dispose() {
    this.disposed = true;
    this.scope?.controller.abort();
  }
}
