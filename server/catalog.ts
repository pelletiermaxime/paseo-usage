import { get } from "node:https";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseRateTable, type RateTable } from "./pricing";

export const PRICE_CACHE_TTL_MS = 12 * 60 * 60_000;
export const PRICE_RETRY_INTERVAL_MS = 60 * 60_000;

function defaultCacheFile() {
  const configured = process.env.XDG_CACHE_HOME;
  const root =
    configured && isAbsolute(configured)
      ? configured
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Caches")
        : process.platform === "win32"
          ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
          : join(homedir(), ".cache");
  return join(root, "paseo-usage", "model-prices.json");
}
function downloadPriceDocument(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = get(
      "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
      { headers: { Accept: "application/json" } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error("Price catalog unavailable"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 30_000_000) {
            request.destroy(new Error("Price catalog too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("Invalid price catalog"));
          }
        });
      },
    );
    const deadline = setTimeout(() => request.destroy(new Error("Price refresh timed out")), 8_000);
    request.on("error", reject);
    request.on("close", () => clearTimeout(deadline));
  });
}
export class PriceCatalog {
  private rates: RateTable = new Map();
  private fetchedAtMs: number | null = null;
  private loading: Promise<void> | null = null;
  private pending: Promise<void> | null = null;
  private lastAttemptAtMs = -Infinity;
  private failed = false;
  constructor(
    private download: () => Promise<unknown> = downloadPriceDocument,
    private cacheFile = defaultCacheFile(),
  ) {}
  async get() {
    this.loading ??= this.loadCache();
    await this.loading;
    const expired =
      this.fetchedAtMs === null || Date.now() - this.fetchedAtMs >= PRICE_CACHE_TTL_MS;
    // History refreshes do not bypass the price TTL. Failed downloads back off separately.
    if (expired && (this.pending || Date.now() - this.lastAttemptAtMs >= PRICE_RETRY_INTERVAL_MS)) {
      this.pending ??= this.refresh().finally(() => {
        this.pending = null;
      });
      await this.pending;
    }
    return {
      rates: this.rates,
      updatedAt: this.fetchedAtMs === null ? undefined : new Date(this.fetchedAtMs).toISOString(),
      failed: this.failed,
    };
  }
  private async loadCache() {
    try {
      const cached = JSON.parse(await readFile(this.cacheFile, "utf8"));
      if (
        cached.version !== 1 ||
        typeof cached.fetchedAtMs !== "number" ||
        !Number.isFinite(cached.fetchedAtMs) ||
        cached.fetchedAtMs < 0 ||
        cached.fetchedAtMs > Date.now()
      )
        return;
      const table = parseRateTable(cached.document);
      if (!table.size) return;
      this.rates = table;
      this.fetchedAtMs = cached.fetchedAtMs;
    } catch {
      /* A missing or corrupt cache leaves prices unavailable until a successful download. */
    }
  }
  private async refresh(): Promise<void> {
    this.lastAttemptAtMs = Date.now();
    try {
      const document = await this.download();
      const table = parseRateTable(document);
      if (!table.size) throw new Error("Empty price catalog");
      this.rates = table;
      this.fetchedAtMs = Date.now();
      this.failed = false;
      const temporary = this.cacheFile + "." + randomUUID() + ".tmp";
      try {
        await mkdir(dirname(this.cacheFile), { recursive: true });
        await writeFile(
          temporary,
          JSON.stringify({ version: 1, fetchedAtMs: this.fetchedAtMs, document }),
        );
        await rename(temporary, this.cacheFile);
      } catch {
        /* Downloaded prices remain usable if the cache directory is unwritable. */
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    } catch {
      this.failed = true;
    }
  }
}
