import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PriceCatalog, PRICE_CACHE_TTL_MS, PRICE_RETRY_INTERVAL_MS } from "../server/catalog";
import { lookupRate } from "../server/pricing";

let root: string, cacheFile: string;
const document = (rate = 0.000001) => ({
  custom: { input_cost_per_token: rate, output_cost_per_token: 0.000003 },
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paseo-prices-test-"));
  cacheFile = join(root, "cache", "model-prices.json");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

test("prices survive catalog restarts and repeated history refreshes until the twelve-hour TTL expires", async () => {
  const download = vi.fn<() => Promise<unknown>>().mockResolvedValue(document());
  const first = new PriceCatalog(download, cacheFile);
  const [a, b] = await Promise.all([first.get(), first.get()]);
  expect(download).toHaveBeenCalledOnce();
  expect(a.failed).toBe(false);
  expect(b.updatedAt).toBe(new Date().toISOString());
  const saved = JSON.parse(await readFile(cacheFile, "utf8"));
  expect(saved.document).toEqual(document());
  expect(saved.fetchedAtMs).toBe(Date.now());
  vi.setSystemTime(Date.now() + 12 * 60 * 60_000 - 1);
  const restarted = new PriceCatalog(download, cacheFile);
  expect(lookupRate((await restarted.get()).rates, "custom")?.inputCostPerToken).toBe(0.000001);
  await first.get();
  expect(download).toHaveBeenCalledOnce();
  vi.setSystemTime(Date.now() + 1);
  download.mockResolvedValue(document(0.000002));
  const [updated, same] = await Promise.all([restarted.get(), restarted.get()]);
  expect(download).toHaveBeenCalledTimes(2);
  expect(updated.updatedAt).toBe(new Date().toISOString());
  expect(lookupRate(same.rates, "custom")?.inputCostPerToken).toBe(0.000002);
  expect((await new PriceCatalog(download, cacheFile).get()).updatedAt).toBe(updated.updatedAt);
  expect(download).toHaveBeenCalledTimes(2);
});

test("an expired disk cache remains usable offline and failed downloads back off without overwriting it", async () => {
  const download = vi.fn<() => Promise<unknown>>().mockResolvedValue(document());
  const original = await new PriceCatalog(download, cacheFile).get();
  const saved = await readFile(cacheFile, "utf8");
  vi.setSystemTime(Date.now() + PRICE_CACHE_TTL_MS);
  download.mockRejectedValue(new Error("offline"));
  const restarted = new PriceCatalog(download, cacheFile);
  const fallback = await restarted.get();
  expect(fallback.failed).toBe(true);
  expect(fallback.updatedAt).toBe(original.updatedAt);
  expect(lookupRate(fallback.rates, "custom")).toEqual(lookupRate(original.rates, "custom"));
  expect(await readFile(cacheFile, "utf8")).toBe(saved);
  vi.setSystemTime(Date.now() + PRICE_RETRY_INTERVAL_MS - 1);
  expect((await restarted.get()).failed).toBe(true);
  expect(download).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.now() + 1);
  download.mockResolvedValue(document(0.000002));
  expect((await restarted.get()).failed).toBe(false);
  expect(download).toHaveBeenCalledTimes(3);
});

test("offline first use has no automatic prices or update timestamp until a download succeeds", async () => {
  const download = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error("offline"));
  const catalog = new PriceCatalog(download, cacheFile);
  const result = await catalog.get();
  expect(result.rates.size).toBe(0);
  expect(result.updatedAt).toBeUndefined();
  expect(result.failed).toBe(true);
  await catalog.get();
  expect(download).toHaveBeenCalledOnce();
  vi.setSystemTime(Date.now() + PRICE_RETRY_INTERVAL_MS);
  download.mockResolvedValue(document());
  const recovered = await catalog.get();
  expect(recovered.failed).toBe(false);
  expect(lookupRate(recovered.rates, "custom")).not.toBeNull();
  expect(recovered.updatedAt).toBe(new Date().toISOString());
});

test.each([
  "not JSON",
  JSON.stringify({ version: 1, fetchedAtMs: 0, document: {} }),
  JSON.stringify({ version: 1, fetchedAtMs: 9e15, document: document() }),
])("an unusable cache is replaced with validated prices: %s", async (contents) => {
  await mkdir(join(root, "cache"));
  await writeFile(cacheFile, contents);
  const download = vi.fn<() => Promise<unknown>>().mockResolvedValue(document());
  const result = await new PriceCatalog(download, cacheFile).get();
  expect(download).toHaveBeenCalledOnce();
  expect(result.failed).toBe(false);
  expect(lookupRate(result.rates, "custom")).not.toBeNull();
  expect(JSON.parse(await readFile(cacheFile, "utf8")).document).toEqual(document());
});

test("an empty downloaded table preserves the last good disk cache and its timestamp", async () => {
  const download = vi.fn<() => Promise<unknown>>().mockResolvedValue(document());
  const catalog = new PriceCatalog(download, cacheFile);
  const first = await catalog.get();
  const saved = await readFile(cacheFile, "utf8");
  vi.setSystemTime(Date.now() + PRICE_CACHE_TTL_MS);
  download.mockResolvedValue({});
  const fallback = await catalog.get();
  expect(fallback.failed).toBe(true);
  expect(fallback.updatedAt).toBe(first.updatedAt);
  expect(await readFile(cacheFile, "utf8")).toBe(saved);
});

test("a cache write failure still serves successful downloads from memory", async () => {
  await mkdir(cacheFile, { recursive: true });
  const download = vi.fn<() => Promise<unknown>>().mockResolvedValue(document());
  const catalog = new PriceCatalog(download, cacheFile);
  const result = await catalog.get();
  expect(result.failed).toBe(false);
  expect(lookupRate(result.rates, "custom")).not.toBeNull();
  await catalog.get();
  expect(download).toHaveBeenCalledOnce();
});
