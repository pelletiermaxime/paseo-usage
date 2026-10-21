import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UsageScreen } from "../client/screen";
const colors = {
  surface0: "#111113",
  surface1: "#1b1b1e",
  surface2: "#28282c",
  border: "#2b2b30",
  foreground: "#ededee",
  foregroundMuted: "#98989f",
  accent: "#ededee",
  accentForeground: "#111113",
  statusSuccess: "#4d9f8a",
  statusWarning: "#d1a35b",
  statusDanger: "#df6868",
};
const queryClient = new QueryClient();
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <UsageScreen
      host={{ id: "preview", label: "This computer" }}
      theme={{ colors }}
      layout={{ compact: false, platform: "web" }}
    />
  </QueryClientProvider>,
);
