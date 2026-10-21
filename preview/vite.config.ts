import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";
import { HistoryReader } from "../server/history";
import { summarize } from "../server/summary";
import { PriceCatalog } from "../server/catalog";
import { summaryRpc, usageSettings } from "../shared/usage";
const root = fileURLToPath(new URL(".", import.meta.url));
const history = new HistoryReader();
const prices = new PriceCatalog();
export default defineConfig({
  root,
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: "react-native-web" },
      { find: /^@getpaseo\/plugin\/client\/react-native$/, replacement: root + "native.tsx" },
      { find: /^@getpaseo\/plugin\/client$/, replacement: root + "host.tsx" },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 5178,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
  },
  plugins: [
    {
      name: "usage-preview-data",
      configureServer(server) {
        server.middlewares.use("/api/summary", async (request, response) => {
          // Development preview only; binds loopback and returns aggregate counts, never transcripts.
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.end();
            return;
          }
          try {
            let body = "";
            for await (const chunk of request) {
              body += chunk;
              if (body.length > 100_000) throw new Error("Oversized request");
            }
            const raw = JSON.parse(body);
            const input = summaryRpc.input.parse(raw.input);
            const settings = usageSettings.schema.parse(raw.settings);
            const [scan, catalog] = await Promise.all([
              history.read(settings, input.refresh),
              prices.get(),
            ]);
            const summary = summarize(
              scan.records,
              scan.sources,
              settings,
              input,
              new Date(),
              catalog.rates,
            );
            summary.pricingUpdatedAt = catalog.updatedAt;
            if (catalog.failed)
              summary.warnings.push(
                catalog.rates.size
                  ? "Model pricing could not be refreshed. The last available price table is still in use."
                  : "Model prices are unavailable. Costs without a custom price or provider-reported cost are marked unpriced.",
              );
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify(summary));
          } catch {
            response.statusCode = 500;
            response.end('{"error":"Could not read preview history"}');
          }
        });
      },
    },
  ],
});
