import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { Select } from "@inkjs/ui";
import { modelId, type ModelConfig, type ModelInfo } from "@harness/protocol";

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
  const options = models.map((m) => ({
    label: `${m.label ?? m.model}${modelId(m) === currentId ? " ✓" : ""}`,
    value: modelId(m),
  }));
  const byId = new Map(models.map((m) => [modelId(m), m]));
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
