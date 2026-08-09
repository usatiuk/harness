import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { Select } from "@inkjs/ui";
import {
  modelId,
  type ModelConfig,
  type ModelIdentityChange,
  type ModelInfo,
  type PresetInfo,
} from "@harness/protocol";

/** A list to pick a model. Assumes a non-empty catalog; `current` is marked. */
export function ModelPicker({
  models,
  current,
  onSelect,
}: {
  models: ModelInfo[];
  current: ModelConfig;
  onSelect: (model: ModelIdentityChange) => void;
}): ReactElement {
  const currentId = modelId(current);
  // Cluster by provider and qualify each label with it; the same model name can appear under
  // multiple providers (e.g. openai vs openai-codex), so a bare name would render as duplicates.
  const sorted = [...models].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );
  const options = sorted.map((m) => ({
    label: `${m.provider}/${m.label ?? m.model}${modelId(m) === currentId ? " ✓" : ""}`,
    value: modelId(m),
  }));
  const byId = new Map(sorted.map((m) => [modelId(m), m]));
  return (
    <Box flexDirection="column">
      <Text bold>
        Switch model <Text dimColor>(esc to cancel)</Text>
      </Text>
      <Select
        options={options}
        onChange={(id) => {
          const m = byId.get(id);
          if (m) onSelect({ provider: m.provider, model: m.model });
        }}
      />
    </Box>
  );
}

/** A list to pick a generation preset for the current model. `current` is marked. */
export function PresetPicker({
  presets,
  current,
  onSelect,
}: {
  presets: PresetInfo[];
  current: string | undefined;
  onSelect: (value: string | undefined) => void;
}): ReactElement {
  const choices: { label: string; preset: string | undefined }[] = [
    { label: `provider default${current === undefined ? " ✓" : ""}`, preset: undefined },
    ...presets.map((entry) => ({
      label: `${entry.label ?? entry.value}${entry.value === current ? " ✓" : ""}`,
      preset: entry.value,
    })),
  ];
  const options = choices.map((choice, index) => ({ label: choice.label, value: String(index) }));
  return (
    <Box flexDirection="column">
      <Text bold>
        Set preset <Text dimColor>(esc to cancel)</Text>
      </Text>
      <Select options={options} onChange={(index) => onSelect(choices[Number(index)]?.preset)} />
    </Box>
  );
}
