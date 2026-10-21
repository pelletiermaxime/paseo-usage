import type { PluginServerContext } from "@getpaseo/plugin/server";
import { summaryRpc, usageSettings } from "./shared/usage";
import { HistoryReader } from "./server/history";
import { summarize } from "./server/summary";
import { PriceCatalog } from "./server/catalog";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(usageSettings);
  const history = new HistoryReader();
  const prices = new PriceCatalog();
  server.handle(summaryRpc, async (input) => {
    const saved = await settings.read();
    if (saved.status !== "ready")
      throw new Error("Usage settings are invalid. Reset them in Usage settings.");
    // Validate before scanning, without returning host paths or raw errors to clients.
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
    } catch {
      throw new Error("Choose a valid time zone to load usage.");
    }
    const [scan, catalog] = await Promise.all([
      history.read(saved.values, input.refresh),
      prices.get(),
    ]);
    const result = summarize(
      scan.records,
      scan.sources,
      saved.values,
      input,
      new Date(),
      catalog.rates,
    );
    if (catalog.failed)
      result.warnings.push(
        catalog.rates.size
          ? "Model pricing could not be refreshed. The last available price table is still in use."
          : "Model prices are unavailable. Costs without a custom price or provider-reported cost are marked unpriced.",
      );
    result.pricingUpdatedAt = catalog.updatedAt;
    return result;
  });
  return () => {};
}
