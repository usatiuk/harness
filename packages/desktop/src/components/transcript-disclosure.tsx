import type { ComponentProps } from "react";
import { Disclosure } from "../ui.tsx";

/** Inner transcript details share document-global exclusivity, separate from Work groups. */
export function TranscriptDisclosure(props: Omit<ComponentProps<typeof Disclosure>, "name">) {
  return <Disclosure {...props} name="conversation-step" />;
}
