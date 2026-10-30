import type { UsageSettings, UsageSummaryInput } from "../shared/usage";
import { ProgressiveHistoryReader } from "./progressive-history";
import { PriceCatalog } from "./catalog";
import { summarize } from "./summary";

export class UsageService {
  constructor(
    private history = new ProgressiveHistoryReader(),
    private prices = new PriceCatalog(),
  ) {}

  async summary(settings: UsageSettings, input: UsageSummaryInput) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
    } catch {
      throw new Error("Choose a valid time zone to load usage.");
    }
    const [scan, catalog] = await Promise.all([
      this.history.read(settings, input.days, input.refresh),
      this.prices.get(),
    ]);
    const result = summarize(
      scan.records,
      scan.sources,
      settings,
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
    return {
      ...result,
      pricingUpdatedAt: catalog.updatedAt,
      historyLoading: scan.historyLoading,
      pricingRefreshing: catalog.refreshing,
    };
  }

  dispose() {
    this.history.dispose();
    this.prices.dispose();
  }
}
