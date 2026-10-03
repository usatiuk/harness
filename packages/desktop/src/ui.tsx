import { Button as RadixButton } from "@radix-ui/themes";
import type { ComponentProps } from "react";

/** Keep form semantics explicit while using the desktop's compact controls. */
export function Button({
  className,
  type = "submit",
  ...props
}: ComponentProps<typeof RadixButton>) {
  const primary = className?.split(" ").includes("primary");
  return (
    <RadixButton
      type={type}
      size="2"
      variant={primary ? "solid" : "surface"}
      color={primary ? "blue" : "gray"}
      radius="small"
      className={className}
      {...props}
    />
  );
}
