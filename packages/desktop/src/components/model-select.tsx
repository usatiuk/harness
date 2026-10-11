import { Select } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import type { ModelInfo } from "@harness/protocol";
import { Tooltip } from "../ui.tsx";

export const modelKey = (provider: string, model: string): string => `${provider}\u0000${model}`;
// Model keys contain a provider/model separator, so this cannot collide with one.
const EMPTY = "conversation-default";

export function ModelSelect({
  models,
  providers = [],
  value,
  name,
  label,
  disabled,
  onValueChange,
  emptyLabel,
}: {
  models: ModelInfo[];
  providers?: readonly { id: string; label: string }[];
  value: string;
  name?: string;
  label: string;
  disabled?: boolean;
  onValueChange: (value: string) => void;
  emptyLabel?: string;
}) {
  const providerLabels = new Map(providers.map((provider) => [provider.id, provider.label]));
  const unavailable =
    value !== "" && !models.some((model) => modelKey(model.provider, model.model) === value);
  return (
    <Select.Root
      value={value || EMPTY}
      onValueChange={(next) => onValueChange(next === EMPTY ? "" : next)}
      {...(disabled !== undefined ? { disabled } : {})}
    >
      <Select.Trigger className="input model-select" aria-label={label}>
        <Select.Value />
        <Select.Icon>
          <ChevronDown size={12} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="menu model-menu" position="popper" sideOffset={6}>
          <Select.Viewport>
            {emptyLabel && (
              <Select.Item className="menu-item" value={EMPTY}>
                <Select.ItemText>{emptyLabel}</Select.ItemText>
              </Select.Item>
            )}
            {unavailable && (
              <Select.Item className="menu-item" value={value}>
                <Select.ItemText>{value.replace("\u0000", " / ")} — unavailable</Select.ItemText>
              </Select.Item>
            )}
            {models.map((model) => (
              <Tooltip.Root key={modelKey(model.provider, model.model)}>
                <Tooltip.Trigger asChild>
                  <Select.Item
                    className="menu-item"
                    value={modelKey(model.provider, model.model)}
                    textValue={`${model.provider} / ${model.label ?? model.model} ${model.model}`}
                  >
                    <Select.ItemText>
                      {providerLabels.get(model.provider) ?? model.provider} /{" "}
                      {model.label ?? model.model}
                      {model.label && model.label !== model.model && (
                        <span className="muted model-id">{` ${model.model}`}</span>
                      )}
                    </Select.ItemText>
                    <Select.ItemIndicator>
                      <Check size={12} />
                    </Select.ItemIndicator>
                  </Select.Item>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content className="tooltip" side="right" sideOffset={8}>
                    <div>
                      {model.provider} / {model.model}
                    </div>
                    {model.contextWindow !== undefined && (
                      <div>{model.contextWindow.toLocaleString()} context tokens</div>
                    )}
                    {model.maxInputTokens !== undefined && (
                      <div>{model.maxInputTokens.toLocaleString()} input tokens</div>
                    )}
                    {model.maxOutputTokens !== undefined && (
                      <div>{model.maxOutputTokens.toLocaleString()} output tokens</div>
                    )}
                    {model.reasoning?.supported !== undefined && (
                      <div>
                        Reasoning: {model.reasoning.supported ? "supported" : "unsupported"}
                      </div>
                    )}
                    {model.presets?.length ? (
                      <div>
                        Presets:{" "}
                        {model.presets.map((preset) => preset.label ?? preset.value).join(", ")}
                      </div>
                    ) : null}
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
      {name && <input type="hidden" name={name} value={value} />}
    </Select.Root>
  );
}
