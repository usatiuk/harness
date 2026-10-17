import { expect, it } from "vitest";
import { decodeModelInfo } from "@harness/client";
import type { ModelInfo } from "@harness/protocol";
import { projectModelInfo } from "./wire.ts";

it.each([true, false, undefined])(
  "preserves image-input metadata %s across the public model boundary",
  (supportsImages) => {
    const model: ModelInfo = {
      provider: "test",
      model: "test",
      ...(supportsImages === undefined ? {} : { supportsImages }),
    };
    const wire = projectModelInfo(model);
    expect(wire.supportsImages).toBe(supportsImages ?? null);
    expect(decodeModelInfo(wire)).toEqual(model);
  },
);
