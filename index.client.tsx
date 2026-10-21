import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { UsageScreen } from "./client/screen";

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
export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: "usage", title: "Usage", Component: UsageScreen }),
    client.addSidebarFooterItem({ id: "usage", title: "Usage", Component: UsageItem }),
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
