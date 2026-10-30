import type {
  PluginClientContext,
  PluginGlobalCommandContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { UsageScreen } from "./client/screen";

// Optional Paseo Max capability; retain the official 0.12.0 SDK for older clients.
interface UsageClient extends Pick<
  PluginClientContext,
  "addScreen" | "addSidebarFooterItem" | "addCommandCenterItem"
> {
  addSidebarFooterIcon?(contribution: {
    id: string;
    title: string;
    icon: string;
    onPress(context: PluginGlobalCommandContext): void;
  }): ReturnType<PluginClientContext["addSidebarFooterItem"]>;
}

function UsageItem(props: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="ChartNoAxesCombined"
      label="Usage"
      active={props.currentScreen?.screenId === "usage"}
      onPress={() => props.openScreen({ screenId: "usage" })}
    />
  );
}
export default function contribute(client: UsageClient) {
  const cleanups = [
    client.addScreen({ id: "usage", title: "Usage", Component: UsageScreen }),
    typeof client.addSidebarFooterIcon === "function"
      ? client.addSidebarFooterIcon({
          id: "usage",
          title: "Usage",
          icon: "ChartNoAxesCombined",
          onPress(context) {
            context.openScreen({ screenId: "usage" });
          },
        })
      : client.addSidebarFooterItem({ id: "usage", title: "Usage", Component: UsageItem }),
    client.addCommandCenterItem({
      id: "usage",
      title: "Open Usage",
      icon: "ChartNoAxesCombined",
      context: "global",
      keywords: ["tokens", "cost", "limits", "spend"],
      onSelect(context) {
        context.openScreen({ screenId: "usage" });
      },
    }),
  ];
  return () => {
    for (const cleanup of cleanups.reverse()) void cleanup();
  };
}
