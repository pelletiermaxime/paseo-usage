import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, test, vi } from "vite-plus/test";
import type { PluginGlobalCommandContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";

vi.mock("../client/screen", () => ({ UsageScreen: () => null }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ SidebarRow: "SidebarRow" }));

const { default: contribute } = await import("../index.client");
type UsageClient = Parameters<typeof contribute>[0];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function register(supported: boolean) {
  const screenCleanup = vi.fn();
  const rowCleanup = vi.fn();
  const iconCleanup = vi.fn();
  const commandCleanup = vi.fn();
  const addScreen = vi.fn<UsageClient["addScreen"]>().mockReturnValue(screenCleanup);
  const addSidebarFooterItem = vi
    .fn<UsageClient["addSidebarFooterItem"]>()
    .mockReturnValue(rowCleanup);
  const addSidebarFooterIcon = vi
    .fn<NonNullable<UsageClient["addSidebarFooterIcon"]>>()
    .mockReturnValue(iconCleanup);
  const addCommandCenterItem = vi
    .fn<UsageClient["addCommandCenterItem"]>()
    .mockReturnValue(commandCleanup);
  const client = {
    addScreen,
    addSidebarFooterItem,
    addCommandCenterItem,
    ...(supported ? { addSidebarFooterIcon } : {}),
  } satisfies UsageClient;

  return {
    addScreen,
    addSidebarFooterItem,
    addSidebarFooterIcon,
    addCommandCenterItem,
    screenCleanup,
    rowCleanup,
    iconCleanup,
    commandCleanup,
    dispose: contribute(client),
  };
}

test("supported clients register one footer icon and open Usage through its host context", () => {
  const fixture = register(true);

  try {
    expect(fixture.addScreen).toHaveBeenCalledOnce();
    expect(fixture.addSidebarFooterIcon).toHaveBeenCalledOnce();
    expect(fixture.addSidebarFooterItem).not.toHaveBeenCalled();

    const icon = fixture.addSidebarFooterIcon.mock.calls[0][0];
    const hostOpenScreen = vi.fn();

    expect(icon).toMatchObject({
      id: "usage",
      title: "Usage",
      icon: "ChartNoAxesCombined",
    });
    icon.onPress({ openScreen: hostOpenScreen } as unknown as PluginGlobalCommandContext);
    expect(hostOpenScreen).toHaveBeenCalledExactlyOnceWith({ screenId: "usage" });
  } finally {
    fixture.dispose();
  }
});

test.each(["ios", "android", "web"] as const)(
  "%s clients without the API keep the existing active Usage row and navigation",
  async (platform) => {
    const fixture = register(false);
    let renderer: ReactTestRenderer | undefined;

    try {
      expect(fixture.addSidebarFooterIcon).not.toHaveBeenCalled();
      expect(fixture.addSidebarFooterItem).toHaveBeenCalledOnce();

      const row = fixture.addSidebarFooterItem.mock.calls[0][0];
      const openScreen = vi.fn();
      const props = {
        currentScreen: { screenId: "usage", params: {} },
        openScreen,
        layout: { platform, compact: true },
      } as unknown as PluginSidebarItemProps;

      await act(async () => {
        renderer = create(createElement(row.Component, props));
      });

      const button = renderer!.root.findByType("SidebarRow" as never);

      expect(button.props).toMatchObject({
        icon: "ChartNoAxesCombined",
        label: "Usage",
        active: true,
      });
      button.props.onPress();
      expect(openScreen).toHaveBeenCalledExactlyOnceWith({ screenId: "usage" });

      await act(async () => {
        renderer!.update(createElement(row.Component, { ...props, currentScreen: null }));
      });
      expect(renderer!.root.findByType("SidebarRow" as never).props.active).toBe(false);
    } finally {
      if (renderer) await act(async () => renderer!.unmount());
      fixture.dispose();
    }
  },
);

test.each([true, false])(
  "Command Center navigation and unload cleanup work with footer icon support=%s",
  async (supported) => {
    const fixture = register(supported);
    const command = fixture.addCommandCenterItem.mock.calls[0][0];
    const hostOpenScreen = vi.fn();

    expect(command).toMatchObject({ id: "usage", title: "Open Usage", context: "global" });
    if (command.context !== "global") throw new Error("Expected a global Usage command");
    await command.onSelect({ openScreen: hostOpenScreen } as unknown as PluginGlobalCommandContext);
    expect(hostOpenScreen).toHaveBeenCalledExactlyOnceWith({ screenId: "usage" });

    fixture.dispose();

    expect(fixture.screenCleanup).toHaveBeenCalledOnce();
    expect(fixture.commandCleanup).toHaveBeenCalledOnce();
    expect(fixture.iconCleanup).toHaveBeenCalledTimes(supported ? 1 : 0);
    expect(fixture.rowCleanup).toHaveBeenCalledTimes(supported ? 0 : 1);
  },
);
