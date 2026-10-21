import { useState } from "react";
import { View } from "react-native";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import type { ModelUsage, UsageSettings } from "../shared/usage";
import { Button, Label, Section, styles, useColors } from "./ui";

export function PriceEditor({
  values,
  models,
  initialModel,
  saving,
  error,
  onSave,
  onClose,
}: {
  values: UsageSettings;
  models: ModelUsage[];
  initialModel?: string;
  saving: boolean;
  error: string | null;
  onSave: (patch: Partial<UsageSettings>) => Promise<boolean>;
  onClose: () => void;
}) {
  const c = useColors();
  const [names, setNames] = useState(() =>
    [
      ...new Set([
        ...models.map((m) => m.model),
        ...Object.keys(values.prices),
        ...Object.keys(values.modelMappings),
        ...(initialModel ? [initialModel] : []),
      ]),
    ].sort(),
  );
  const [newModel, setNewModel] = useState("");
  const [draft, setDraft] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      names.map((model) => {
        const rate = values.prices[model] ?? models.find((m) => m.model === model)?.price;
        return [
          model,
          [
            rate?.inputCostPerMillionTokens,
            rate?.outputCostPerMillionTokens,
            rate?.cacheReadCostPerMillionTokens,
            rate?.cacheWriteCostPerMillionTokens,
          ].map((v) => (v == null ? "" : String(v))),
        ];
      }),
    ),
  );
  const [mappings, setMappings] = useState({ ...values.modelMappings });
  const [dirty, setDirty] = useState(new Set<string>());
  const [reset, setReset] = useState(new Set<string>());
  const [validation, setValidation] = useState<string | null>(null);
  const field = {
    color: c.foreground,
    backgroundColor: c.surface0,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 5,
    padding: 8,
    fontSize: 12,
    minWidth: 82,
  };
  async function save() {
    const prices = { ...values.prices };
    const modelMappings = { ...values.modelMappings };
    for (const model of reset) {
      delete prices[model];
      delete modelMappings[model];
    }
    for (const model of names) {
      if (reset.has(model)) continue;
      const target = mappings[model]?.trim();
      if (target) {
        // One-hop mappings keep attribution and rate selection unambiguous.
        if (target === model || mappings[target]?.trim()) {
          setValidation("Map " + model + " directly to an unmapped model.");
          return;
        }
        modelMappings[model] = target;
      } else delete modelMappings[model];
      if (!dirty.has(model)) continue;
      const raw = draft[model] ?? ["", "", "", ""];
      if (
        !raw[0].trim() ||
        !raw[1].trim() ||
        raw.some(
          (v) =>
            v.trim() && (!Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > 1_000_000),
        )
      ) {
        setValidation(
          "Enter nonnegative input and output prices for " + model + ". Cache prices are optional.",
        );
        return;
      }
      prices[model] = {
        inputCostPerMillionTokens: Number(raw[0]),
        outputCostPerMillionTokens: Number(raw[1]),
        ...(raw[2].trim() ? { cacheReadCostPerMillionTokens: Number(raw[2]) } : {}),
        ...(raw[3].trim() ? { cacheWriteCostPerMillionTokens: Number(raw[3]) } : {}),
      };
    }
    setValidation(null);
    if (await onSave({ prices, modelMappings })) onClose();
  }
  return (
    <Modal
      title="Model prices"
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Modal.Content>
        <Label muted>
          USD per million tokens. Saved prices replace automatic pricing for this host's history.
          Blank cache prices use the input price. Enter 0 for free tokens.
        </Label>
        <View style={[styles.row, { flexWrap: "wrap" }]}>
          <TextInput
            accessibilityLabel="Add model ID"
            value={newModel}
            onChangeText={setNewModel}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Exact model ID"
            placeholderTextColor={c.foregroundMuted}
            style={[field, { flex: 1 }]}
          />
          <Button
            icon="Plus"
            disabled={saving || !newModel.trim()}
            onPress={() => {
              const model = newModel.trim();
              if (!names.includes(model)) {
                setNames([...names, model]);
                setDraft({ ...draft, [model]: ["", "", "", ""] });
              }
              setNewModel("");
            }}
          >
            Add model
          </Button>
        </View>
        {names.length === 0 && <Label muted>Add a model ID to set its API price.</Label>}
        {names.map((model) => (
          <View
            key={model}
            style={{
              gap: 10,
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderColor: c.border,
              opacity: reset.has(model) ? 0.5 : 1,
            }}
          >
            <View style={styles.between}>
              <Label selectable style={{ fontWeight: "500", flex: 1 }}>
                {model}
              </Label>
              <Button
                disabled={saving}
                onPress={() =>
                  setReset((previous) => {
                    const next = new Set(previous);
                    if (next.has(model)) next.delete(model);
                    else next.add(model);
                    return next;
                  })
                }
              >
                {reset.has(model) ? "Undo reset" : "Reset to automatic"}
              </Button>
            </View>
            <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
              {["Input", "Output", "Cache read", "Cache write"].map((label, index) => (
                <View key={label} style={{ flexBasis: 95, flexGrow: 1, gap: 4 }}>
                  <Label muted style={{ fontSize: 10 }}>
                    {label}
                  </Label>
                  <TextInput
                    accessibilityLabel={model + " " + label + " price"}
                    keyboardType="decimal-pad"
                    value={draft[model]?.[index] ?? ""}
                    placeholder={index > 1 ? "Input rate" : "Unpriced"}
                    placeholderTextColor={c.foregroundMuted}
                    editable={!saving && !reset.has(model)}
                    style={field}
                    onChangeText={(value) => {
                      const row = [...(draft[model] ?? ["", "", "", ""])];
                      row[index] = value;
                      setDraft({ ...draft, [model]: row });
                      setDirty(new Set([...dirty, model]));
                    }}
                  />
                </View>
              ))}
            </View>
            <TextInput
              accessibilityLabel={model + " map to"}
              value={mappings[model] ?? ""}
              onChangeText={(target) => setMappings({ ...mappings, [model]: target })}
              editable={!saving && !reset.has(model)}
              placeholder="Map to another exact model ID (optional)"
              placeholderTextColor={c.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={field}
            />
          </View>
        ))}
        {(validation || error) && (
          <Label style={{ color: c.statusDanger }}>{validation || error}</Label>
        )}
        <View style={[styles.row, { justifyContent: "flex-end" }]}>
          <Button disabled={saving} onPress={onClose}>
            Cancel
          </Button>
          <Button icon="Check" selected disabled={saving} onPress={() => void save()}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </View>
      </Modal.Content>
    </Modal>
  );
}

export function SourceEditor({
  values,
  saving,
  error,
  onSave,
  onClose,
}: {
  values: UsageSettings;
  saving: boolean;
  error: string | null;
  onSave: (patch: Partial<UsageSettings>) => Promise<boolean>;
  onClose: () => void;
}) {
  const c = useColors();
  const fields = [
    {
      key: "codexHomes",
      label: "Additional Codex homes",
      hint: "CODEX_HOME or ~/.codex; sessions and archived_sessions",
    },
    {
      key: "claudeHomes",
      label: "Additional Claude homes",
      hint: "CLAUDE_CONFIG_DIR or ~/.claude; projects",
    },
    {
      key: "grokHomes",
      label: "Additional Grok homes",
      hint: "GROK_HOME or ~/.grok; sessions/**/updates.jsonl",
    },
    {
      key: "piSessionDirs",
      label: "Additional Pi session directories",
      hint: "PI_CODING_AGENT_SESSION_DIR, or sessions under PI_CODING_AGENT_DIR or ~/.pi/agent",
    },
    {
      key: "opencodeDataDirs",
      label: "Additional OpenCode data directories",
      hint: "OPENCODE_DATA_DIR or $XDG_DATA_HOME/opencode (default ~/.local/share/opencode)",
    },
    {
      key: "antigravityDataDirs",
      label: "Additional Antigravity data directories",
      hint: "ANTIGRAVITY_DATA_DIR, ~/.gemini/antigravity variants, or ~/.config/antigravity",
    },
    {
      key: "cursorAuthFiles",
      label: "Additional Cursor CLI login files",
      hint: "Default CLI auth.json: ~/.config/cursor on Linux, %APPDATA%/Cursor on Windows, ~/.cursor with file storage on macOS",
    },
  ] as const;
  const [locations, setLocations] = useState(
    () =>
      Object.fromEntries(
        fields.map((field) => [field.key, values[field.key].join("\n")]),
      ) as Record<(typeof fields)[number]["key"], string>,
  );
  const [keychain, setKeychain] = useState(values.cursorKeychainEnabled);
  const paths = (text: string) => [
    ...new Set(
      text
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  ];
  return (
    <Modal
      title="History sources"
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Modal.Content>
        <Label muted>
          Usage reads Codex, Claude Code, Grok, OpenCode, Antigravity, and Pi history on this host,
          including sessions outside Paseo. Cursor reads account-wide history from cursor.com using
          a saved CLI login and can include other machines. Add paths below, one absolute or ~/ path
          per line.
        </Label>
        <Label muted>
          Logs and databases are read directly from each provider. T3 Code data is never read.
          Prompts, responses, and credentials are never sent to clients. Cursor credentials are used
          only with cursor.com. Duplicate usage records count once.
        </Label>
        {fields.map((field) => (
          <Section key={field.key} title={field.label}>
            <Label muted style={{ fontSize: 11 }}>
              {field.hint}
            </Label>
            <TextInput
              accessibilityLabel={field.label}
              multiline
              editable={!saving}
              value={locations[field.key]}
              onChangeText={(text) =>
                setLocations((current) => ({ ...current, [field.key]: text }))
              }
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="~/another-account"
              placeholderTextColor={c.foregroundMuted}
              style={{
                minHeight: 90,
                color: c.foreground,
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 6,
                padding: 10,
                textAlignVertical: "top",
              }}
            />
          </Section>
        ))}
        <Button
          selected={keychain}
          disabled={saving}
          icon={keychain ? "Check" : "Minus"}
          onPress={() => setKeychain((value) => !value)}
        >
          Allow Cursor Keychain access on macOS
        </Button>
        <Label muted>
          Enabling this may show a Keychain access prompt on the Mac running the Paseo host.
        </Label>
        {error && <Label style={{ color: c.statusDanger }}>{error}</Label>}
        <View style={[styles.row, { justifyContent: "flex-end" }]}>
          <Button disabled={saving} onPress={onClose}>
            Cancel
          </Button>
          <Button
            selected
            disabled={saving}
            onPress={() =>
              void (async () => {
                if (
                  await onSave({
                    ...Object.fromEntries(
                      fields.map((field) => [field.key, paths(locations[field.key])]),
                    ),
                    cursorKeychainEnabled: keychain,
                  })
                )
                  onClose();
              })()
            }
          >
            Save sources
          </Button>
        </View>
      </Modal.Content>
    </Modal>
  );
}
