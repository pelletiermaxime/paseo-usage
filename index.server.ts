import type { PluginServerContext } from "@getpaseo/plugin/server";
import { summaryRpc, usageSettings } from "./shared/usage";
import { UsageService } from "./server/usage-service";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(usageSettings);
  const usage = new UsageService();
  server.handle(summaryRpc, async (input) => {
    const saved = await settings.read();
    if (saved.status !== "ready")
      throw new Error("Usage settings are invalid. Reset them in Usage settings.");
    return usage.summary(saved.values, input);
  });
  return () => usage.dispose();
}
