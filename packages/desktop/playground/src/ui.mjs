import { createElement as h } from "react";
import { Select as NativeSelect } from "../../src/ui.tsx";
export { Button, Field, Icon, IconButton, Input, PopoverControl, Section } from "../../src/ui.tsx";

// Specimen data adapter; the production Select retains native children/form props.
export function Select({ options, ...props }) {
  return h(
    NativeSelect,
    props,
    options.map((option) => h("option", { key: option, value: option }, option)),
  );
}
