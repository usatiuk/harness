import type { ModelConfig, ModelInfo } from "@harness/protocol";
import type { ProviderStatus } from "@harness/server/client-protocol";

export function modelAvailabilityMessage(
  models: ModelInfo[],
  providers: ProviderStatus[],
  model: ModelConfig,
): string | undefined {
  if (
    models.some(
      (candidate) => candidate.provider === model.provider && candidate.model === model.model,
    )
  )
    return undefined;
  const provider = providers.find((candidate) => candidate.id === model.provider);
  if (!provider)
    return `Configured provider '${model.provider}' is unavailable. Check global provider configuration and restart Harness.`;
  const identity = `${provider.label} (${model.provider}/${model.model})`;
  if (provider.catalog === "missing-credentials")
    return `${identity} has no credentials. Run \`harness auth login --provider ${model.provider}\` or configure its environment source, then restart Harness.`;
  return `${identity} is unavailable: ${provider.catalog}${provider.diagnostics.length ? ` · ${provider.diagnostics.join("; ")}` : " · model is not advertised or configured"}. Your selection is preserved.`;
}
