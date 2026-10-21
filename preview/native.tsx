import type { PropsWithChildren, ReactNode } from "react";
import { TextInput as Input } from "react-native";
export const TextInput = Input;
const symbols: Record<string, string> = {
  ChevronDown: "⌄",
  RefreshCw: "↻",
  Check: "✓",
  Plus: "+",
  Minus: "−",
  FolderOpen: "▱",
  SlidersHorizontal: "☷",
};
export function Icon({ name, color, size }: { name: string; color: string; size: number }) {
  return <span style={{ color, fontSize: size, lineHeight: 1 }}>{symbols[name] ?? "◇"}</span>;
}
export function Modal({
  title,
  open,
  onOpenChange,
  children,
}: PropsWithChildren<{ title: string; open: boolean; onOpenChange: (open: boolean) => void }>) {
  if (!open) return null;
  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
      style={{
        position: "fixed",
        zIndex: 20,
        inset: 0,
        background: "#0009",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          background: "#161618",
          color: "#ededed",
          border: "1px solid #343437",
          borderRadius: 12,
          maxHeight: "90vh",
          overflow: "auto",
          width: 760,
          maxWidth: "100%",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "18px 24px",
            borderBottom: "1px solid #343437",
            position: "sticky",
            top: 0,
            background: "#161618",
            zIndex: 1,
          }}
        >
          <strong>{title}</strong>
          <button
            aria-label="Close dialog"
            onClick={() => onOpenChange(false)}
            style={{ border: 0, background: "none", color: "inherit", cursor: "pointer" }}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
Modal.Content = ({ children }: { children: ReactNode }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: 24 }}>{children}</div>
);
