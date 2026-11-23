import { replace, type LoaderFunctionArgs } from "react-router";

export const sections = [
  "Appearance",
  "Composer",
  "Instructions",
  "Defaults",
  "Providers",
  "Feedback",
  "MCP",
  "Worktrees",
  "Application",
] as const;

export function settingsSection(requested: string | null | undefined) {
  return sections.find((label) => label.toLowerCase() === requested)?.toLowerCase() ?? "appearance";
}

export function legacySettingsTarget(search: string | undefined) {
  const legacy = new URLSearchParams(search).get("section");
  return legacy === null ? undefined : `/settings/${settingsSection(legacy)}`;
}

export function settingsLoader({ request, params }: LoaderFunctionArgs) {
  const target = !params.section && legacySettingsTarget(new URL(request.url).search);
  return target ? replace(target) : null;
}
