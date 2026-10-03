import { expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { ModelPicker } from "./model-picker.tsx";

it("shows instance labels while selecting stable provider/model identities", async () => {
  const select = vi.fn();
  const view = render(
    <ModelPicker
      models={[
        { provider: "work", model: "coding" },
        { provider: "personal", model: "coding" },
      ]}
      providerLabels={{ work: "Work gateway", personal: "Personal gateway" }}
      current={{ provider: "work", model: "coding" }}
      onSelect={select}
    />,
  );
  try {
    await vi.waitFor(() => expect(view.lastFrame()).toContain("Work gateway (work) / coding ✓"));
    expect(view.lastFrame()).toContain("Personal gateway (personal) / coding");
    // Alphabetical provider order starts with personal; the label never becomes a selection ID.
    view.stdin.write("\r");
    await vi.waitFor(() =>
      expect(select).toHaveBeenCalledWith({ provider: "personal", model: "coding" }),
    );
  } finally {
    view.unmount();
  }
});
