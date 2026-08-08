import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { Select } from "@inkjs/ui";
import { modelId, type ModelConfig, type ModelInfo, type PresetInfo } from "@harness/protocol";

/** A list to pick a model. Assumes a non-empty catalog; `current` is marked. */
export function ModelPicker({
  models,
  current,
  onSelect,
}: {
  models: ModelInfo[];
  current: ModelConfig;
  onSelect: (model: ModelConfig) => void;
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
  onSelect: (value: string) => void;
}): ReactElement {
  const options = presets.map((e) => ({
    label: `${e.label ?? e.value}${e.value === current ? " ✓" : ""}`,
    value: e.value,
  }));
  return (
    <Box flexDirection="column">
      <Text bold>
        Set preset <Text dimColor>(esc to cancel)</Text>
      </Text>
      <Select options={options} onChange={onSelect} />
    </Box>
  );
}
