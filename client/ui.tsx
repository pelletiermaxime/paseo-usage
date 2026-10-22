import { createContext, useContext, useState, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

export const Theme = createContext<PluginSurfaceProps["theme"] | null>(null);
export function useColors() {
  const theme = useContext(Theme);
  if (!theme) throw new Error("Usage theme is missing.");
  return theme.colors;
}
export function Label({
  children,
  muted,
  style,
  selectable = false,
}: {
  children: ReactNode;
  muted?: boolean;
  style?: StyleProp<TextStyle>;
  selectable?: boolean;
}) {
  const c = useColors();
  return (
    <Text
      selectable={selectable}
      style={[
        { color: muted ? c.foregroundMuted : c.foreground, fontSize: 13, lineHeight: 19 },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
export function Button({
  children,
  icon,
  onPress,
  selected,
  disabled,
  label,
  style,
}: {
  children?: ReactNode;
  icon?: string;
  onPress: () => void;
  selected?: boolean;
  disabled?: boolean;
  label?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? (typeof children === "string" ? children : undefined)}
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        {
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: 6,
          flexDirection: "row",
          gap: 7,
          alignItems: "center",
          backgroundColor: selected ? c.surface2 : hovered || pressed ? c.surface1 : "transparent",
          opacity: disabled ? 0.4 : 1,
          borderWidth: 1,
          borderColor: selected ? c.border : "transparent",
        },
        style,
      ]}
    >
      {icon && <Icon name={icon} size={15} color={selected ? c.foreground : c.foregroundMuted} />}
      {children && (
        <Label muted={!selected} style={{ fontSize: 12, fontWeight: selected ? "500" : "400" }}>
          {children}
        </Label>
      )}
    </Pressable>
  );
}
export function Segments<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
}) {
  const c = useColors();
  return (
    <View
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        backgroundColor: c.surface1,
        borderRadius: 7,
        padding: 2,
        alignSelf: "flex-start",
      }}
    >
      {options.map((option) => (
        <Button
          key={option.value}
          selected={option.value === value}
          disabled={disabled}
          onPress={() => onChange(option.value)}
          label={option.label}
        >
          {option.label}
        </Button>
      ))}
    </View>
  );
}
export const money = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n > 0 && n < 0.01 ? 4 : 2,
  }).format(n);
export const count = (n: number) =>
  n >= 1e9
    ? (n / 1e9).toFixed(2) + "B"
    : n >= 1e6
      ? (n / 1e6).toFixed(2) + "M"
      : n >= 1e3
        ? (n / 1e3).toFixed(1) + "K"
        : n.toLocaleString("en-US");
export const costLabel = ({ cost, unpriced }: { cost: number; unpriced: number }) =>
  unpriced > 0 ? (cost === 0 ? "Unpriced" : money(cost) + " · partial") : money(cost);
export const percent = (n: number) => (n * 100).toFixed(1) + "%";
export const providerLabel = (id: string) =>
  ({
    codex: "Codex",
    claude: "Claude Code",
    opencode: "OpenCode",
    cursor: "Cursor",
    grok: "Grok Build",
    pi: "Pi",
    antigravity: "Antigravity",
    copilot: "GitHub Copilot",
  })[id] ?? id;
export const providerColor = (id: string, foreground: string) =>
  ({
    codex: foreground,
    claude: "#d97757",
    opencode: "#5b9bbd",
    cursor: "#8b8b8b",
    grok: "#909090",
    pi: "#4d9f8a",
    antigravity: "#7195ed",
  })[id] ?? "#8c7bd1";
export function ProviderMark({ provider, small }: { provider: string; small?: boolean }) {
  const c = useColors();
  // Keep the mark legible at t3code's small provider-icon size on every platform.
  return (
    <View
      style={{
        width: small ? 14 : 17,
        height: small ? 14 : 17,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Label
        style={{
          fontSize: provider === "claude" ? 21 : 15,
          lineHeight: 21,
          fontWeight: "600",
          color: providerColor(provider, c.foreground),
        }}
      >
        {provider === "claude" ? "✳" : provider === "codex" ? "⬡" : "◇"}
      </Label>
    </View>
  );
}
export function Section({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 12 }}>
      <View style={styles.between}>
        <Label style={{ fontSize: 14, fontWeight: "500" }}>{title}</Label>
        {trailing}
      </View>
      {children}
    </View>
  );
}
export const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  number: { fontVariant: ["tabular-nums"] },
});
