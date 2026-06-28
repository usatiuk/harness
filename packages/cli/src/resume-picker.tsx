import type { ReactElement } from "react";
import { basename } from "node:path";
import { Box, Text } from "ink";
import { Select } from "@inkjs/ui";
import type { Conversation } from "@harness/protocol";

/** A list to pick a conversation to resume. Assumes a non-empty list. */
export function ResumePicker({
  conversations,
  showingAll,
  onSelect,
}: {
  conversations: Conversation[];
  showingAll: boolean;
  onSelect: (id: string) => void;
}): ReactElement {
  const options = conversations.map((c) => ({
    label: `${shortId(c.id)} · ${workspaceLabel(c.workspaceRoot)} · ${c.config.model.model} · ${timeAgo(c.createdAt)}`,
    value: c.id,
  }));
  return (
    <Box flexDirection="column">
      <Text bold>
        Resume a conversation{" "}
        <Text
          dimColor
        >{`(${showingAll ? "all projects" : "this project"} · a to toggle · esc to cancel)`}</Text>
      </Text>
      <Select options={options} onChange={onSelect} />
    </Box>
  );
}

const shortId = (id: string): string => id.slice(0, 8);

/** Basename of the conversation's workspace, or a placeholder for projectless ones. */
const workspaceLabel = (root: string | null | undefined): string =>
  root ? basename(root) : "no workspace";

/** Coarse relative time ("3m ago"), no dependency. */
function timeAgo(epochMs: number): string {
  const secs = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
