// Adapted from T3 Code accountUsage.ts (MIT). See ../THIRD_PARTY_NOTICES.md.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { missing, roots, sourceState, yieldScan, type SourceScan } from "./source-files";
import type { UsageSettings } from "../shared/usage";
import type { UsageRecord } from "./types";

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const tokens = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
const URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";
export type CursorFetch = (
  url: string,
  options: {
    method: "POST";
    redirect: "error";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;
// React Native augments fetch's signal type; the daemon uses Node's AbortSignal.
const cursorFetch: CursorFetch = (url, options) =>
  fetch(url, {
    ...options,
    signal: options.signal as NonNullable<Parameters<typeof fetch>[1]>["signal"],
  });
export function cursorRateModel(model: string) {
  const base = model
    .replace(/^cursor-/, "")
    .replace(/(?:-thinking)?(?:-(?:none|minimal|low|medium|high|xhigh|max))?(?:-fast)?$/, "");
  return base.startsWith("grok-") ? `xai/${base}` : base;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function boundaryOverlap(previous: string[], current: string[]) {
  const sequence = [...current, "", ...previous];
  const lengths = Array.from({ length: sequence.length }, () => 0);
  for (let index = 1; index < sequence.length; index++) {
    let length = lengths[index - 1]!;
    while (length > 0 && sequence[index] !== sequence[length]) length = lengths[length - 1]!;
    if (sequence[index] === sequence[length]) length++;
    lengths[index] = length;
  }
  return lengths.at(-1) ?? 0;
}

export async function readCursorAccountUsage(
  accessToken: string,
  sinceMs: number,
  endDate: number,
  fetchApi: CursorFetch = cursorFetch,
): Promise<{ accountKey: string; records: UsageRecord[] }> {
  const subject = object(
    JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")),
  ).sub;
  if (typeof subject !== "string" || !subject || !subject.split("|").at(-1))
    throw new Error("Invalid authentication");
  if (!Number.isFinite(sinceMs) || !Number.isFinite(endDate) || sinceMs < 0 || sinceMs > endDate)
    throw new Error("Invalid date window");
  const accountKey = hash(subject),
    pages: unknown[][] = [];
  let total: number | undefined;
  const deadline = AbortSignal.timeout(60_000);
  for (let page = 1; ; page++) {
    if (page > (total === undefined ? 1000 : Math.ceil(total / 1000) * 2 + 1))
      throw new Error("Account usage page limit exceeded");
    const response = await fetchApi(URL, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://cursor.com",
        Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${subject.split("|").at(-1)}::${accessToken}`)}`,
      },
      body: JSON.stringify({
        page,
        pageSize: 1000,
        startDate: String(sinceMs),
        endDate: String(endDate),
      }),
      signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
    });
    if (response.status === 401 || response.status === 403)
      throw new Error("Sign in to Cursor again to read account usage.");
    if (!response.ok) throw new Error("Cursor account usage request failed.");
    const parsed: unknown = await response.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Invalid account usage page");
    const body = object(parsed),
      keys = Object.keys(body);
    if ("error" in body || "message" in body || "code" in body)
      throw new Error("Account usage error response");
    const count = keys.length === 0 ? 0 : body.totalUsageEventsCount;
    const events =
      keys.length === 0 || (keys.length === 1 && keys[0] === "totalUsageEventsCount")
        ? []
        : body.usageEventsDisplay;
    if (
      (count !== undefined &&
        (typeof count !== "number" ||
          !Number.isSafeInteger(count) ||
          count < 0 ||
          (total !== undefined && count !== total))) ||
      !Array.isArray(events) ||
      events.length > 1000 ||
      (count === undefined && !Array.isArray(body.usageEventsDisplay))
    )
      throw new Error("Inconsistent account usage page");
    if (typeof count === "number") total = count;
    pages.push(events);
    if (events.length < 1000) break;
    await yieldScan();
  }
  const rawCount = pages.reduce((sum, page) => sum + page.length, 0);
  if (total !== undefined && rawCount < total) throw new Error("Incomplete account usage pages");
  let removalsRemaining = total === undefined ? 0 : rawCount - total;
  let previousKeys: string[] = [];
  const records: UsageRecord[] = [],
    occurrences = new Map<string, number>();
  for (const events of pages) {
    const eventKeys =
      removalsRemaining > 0 ? events.map((event) => hash(canonicalJson(event))) : [];
    const removalCount = Math.min(removalsRemaining, boundaryOverlap(previousKeys, eventKeys));
    removalsRemaining -= removalCount;
    previousKeys = eventKeys;
    for (const raw of events.slice(removalCount)) {
      const event = object(raw),
        usage = object(event.tokenUsage);
      if (event.tokenUsage === undefined || event.tokenUsage === null) continue;
      for (const key of [
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "totalCents",
      ]) {
        const value = usage[key];
        if (
          value !== undefined &&
          (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        )
          throw new Error("Invalid account usage totals");
      }
      const timestampMs =
        typeof event.timestamp === "string" && event.timestamp.trim() !== ""
          ? Number(event.timestamp)
          : event.timestamp;
      if (
        typeof timestampMs !== "number" ||
        !Number.isFinite(timestampMs) ||
        typeof event.model !== "string" ||
        !event.model
      )
        throw new Error("Invalid account usage event");
      if (timestampMs < sinceMs || timestampMs > endDate) continue;
      const totals = {
        uncachedInputTokens: tokens(usage.inputTokens),
        cachedInputTokens: tokens(usage.cacheReadTokens),
        cacheCreationTokens: tokens(usage.cacheWriteTokens),
        outputTokens: tokens(usage.outputTokens),
        reasoningTokens: 0,
      };
      const reportedCostUsd = typeof usage.totalCents === "number" ? usage.totalCents / 100 : null;
      const sessionId = typeof event.conversationId === "string" ? event.conversationId : "";
      const key = hash(
        JSON.stringify([timestampMs, event.model, sessionId, totals, reportedCostUsd]),
      );
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      records.push({
        provider: "cursor",
        timestampMs,
        model: event.model,
        rateModel: cursorRateModel(event.model),
        sessionId,
        totals,
        reportedCostUsd,
        speed: "standard",
        dedupeKey: `cursor-account:${accountKey}:${key}:${occurrence}`,
      });
    }
    await yieldScan();
  }
  if (removalsRemaining !== 0) throw new Error("Inconsistent account usage boundaries");
  return { accountKey, records };
}

export function defaultCursorAuthPath() {
  if (process.platform === "darwin") return join(homedir(), ".cursor", "auth.json");
  if (process.platform === "win32")
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "Cursor",
      "auth.json",
    );
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"), "cursor", "auth.json");
}
export class CursorReader {
  private cache = new Map<
    string,
    {
      at: number;
      sinceMs: number;
      result: Awaited<ReturnType<typeof readCursorAccountUsage>> | null;
    }
  >();
  constructor(private fetchApi: CursorFetch = cursorFetch) {}
  async read(settings: UsageSettings, sinceMs: number, refresh = false): Promise<SourceScan> {
    const source = sourceState("cursor"),
      records: UsageRecord[] = [],
      seenAccounts = new Set<string>(),
      active = new Set<string>();
    let errors = 0;
    const collect = async (token: string) => {
      const key = hash(token);
      if (active.has(key)) return;
      active.add(key);
      let cached = this.cache.get(key);
      if (!cached || cached.sinceMs > sinceMs || refresh || Date.now() - cached.at >= 5 * 60_000) {
        try {
          const result = await readCursorAccountUsage(token, sinceMs, Date.now(), this.fetchApi);
          cached = { at: Date.now(), sinceMs, result };
          this.cache.set(key, cached);
        } catch (error) {
          this.cache.set(key, { at: Date.now(), sinceMs, result: null });
          throw error;
        }
      }
      if (!cached.result) throw new Error("Cursor account usage could not be read.");
      if (seenAccounts.has(cached.result.accountKey)) return;
      seenAccounts.add(cached.result.accountKey);
      source.files++;
      records.push(...cached.result.records.filter((record) => record.timestampMs >= sinceMs));
    };
    const defaultFile =
      process.platform !== "darwin" || process.env.AGENT_CLI_CREDENTIAL_STORE === "file";
    const defaultUnavailable = !!(
      process.env.CURSOR_API_KEY ||
      process.env.CURSOR_AUTH_TOKEN ||
      process.env.AGENT_CLI_CREDENTIAL_STORE === "memory"
    );
    const paths = await roots([
      ...(defaultFile && !defaultUnavailable ? [defaultCursorAuthPath()] : []),
      ...settings.cursorAuthFiles,
    ]);
    for (const path of paths) {
      try {
        const token = object(JSON.parse(await readFile(path, "utf8"))).accessToken;
        if (typeof token === "string" && token.trim()) await collect(token.trim());
      } catch (error) {
        if (!missing(error)) errors++;
      }
    }
    if (
      process.platform === "darwin" &&
      !defaultFile &&
      !defaultUnavailable &&
      settings.cursorKeychainEnabled
    ) {
      try {
        const { stdout } = await promisify(execFile)(
          "/usr/bin/security",
          ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"],
          { timeout: 10_000, maxBuffer: 64 * 1024 },
        );
        if (stdout.trim()) await collect(stdout.trim());
      } catch {
        errors++;
      }
    }
    for (const key of this.cache.keys()) if (!active.has(key)) this.cache.delete(key);
    source.records = records.length;
    source.status = errors ? "partial" : source.files ? "ready" : "missing";
    source.message = errors
      ? "Cursor account history could not be read. Check the CLI login and connection, then refresh."
      : !source.files
        ? "Cursor history needs a saved Cursor CLI login. On macOS, enable Keychain access in History sources."
        : "Cursor history is account-wide and includes usage on other machines.";
    return { records, source };
  }
}
