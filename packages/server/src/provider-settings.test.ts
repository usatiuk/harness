import { expect, it } from "vitest";
import { z } from "zod";
import { providerSettings } from "./provider-settings.ts";

it("requires an implemented shape and a valid effective value for explicitly exposed settings", () => {
  const metadata = { harnessSetting: true, title: "Setting" };
  expect(() =>
    providerSettings(z.object({ setting: z.string().meta(metadata) }), { setting: "x" }),
  ).toThrow("must be a boolean");
  expect(() =>
    providerSettings(z.object({ setting: z.boolean().optional().meta(metadata) }), {}),
  ).toThrow("requires a boolean value or default");
  expect(() =>
    providerSettings(z.object({ setting: z.boolean().meta({ harnessSetting: true }) }), {
      setting: true,
    }),
  ).toThrow("requires a title");
  expect(providerSettings(z.object({ opaque: z.custom() }), { opaque: "private" })).toEqual([]);
});
