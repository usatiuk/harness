import type { McpTimeouts } from "@harness/mcp/client";
import { Disclosure, Input } from "../ui.tsx";

const labels = {
  startupSeconds: "Startup and discovery",
  executionSeconds: "Tool execution",
  stdioProbeSeconds: "Stdio protocol probe",
} satisfies Record<keyof McpTimeouts, string>;

export function McpTimeoutFields({
  defaults,
  overrides,
  disabled,
  stdio = true,
  onSave,
}: {
  defaults: McpTimeouts;
  overrides?: Partial<McpTimeouts>;
  disabled: boolean;
  stdio?: boolean;
  onSave: (values: Partial<McpTimeouts>) => void;
}) {
  return (
    <Disclosure title="Timeouts">
      {Object.entries(labels).map(([field, label]) => {
        if (!stdio && field === "stdioProbeSeconds") return null;
        const key = field as keyof McpTimeouts;
        const value = overrides ? overrides[key] : defaults[key];
        return (
          <label key={key}>
            {label} (seconds)
            <Input
              type="number"
              min="0.001"
              max="2147483"
              step="any"
              required={!overrides}
              disabled={disabled}
              defaultValue={value}
              placeholder={`Inherited · ${defaults[key]} s`}
              onBlur={({ currentTarget: input }) => {
                if (!input.reportValidity()) {
                  input.value = String(value ?? "");
                  return;
                }
                const next = input.value === "" ? undefined : input.valueAsNumber;
                if (next === value) return;
                const values = { ...(overrides ?? defaults) };
                if (next === undefined) delete values[key];
                else values[key] = next;
                onSave(values);
              }}
            />
          </label>
        );
      })}
      <small>
        {overrides ? "Clear an override to inherit the host default. " : ""}
        {stdio &&
          "Silent stdio servers try legacy initialization after the probe, at most halfway through the startup budget."}
      </small>
    </Disclosure>
  );
}
