import { describe, expect, test, vi } from "vitest";
import {
    createCliProgram,
    defaultDbPath,
    defaultHarnessHome,
} from "../src/cli.ts";

describe("CLI command wiring", () => {
    test("shows the configured default harness paths", () => {
        const help = createCliProgram().helpInformation();

        expect(defaultHarnessHome()).toMatch(/\.harness$/u);
        expect(defaultDbPath()).toBe(`${defaultHarnessHome()}/harness.sqlite`);
        expect(createCliProgram().helpInformation()).toBe(help);
        expect(help).toContain("Commands:");
    }, 5000);

    test("auth status uses auth-only dependencies instead of constructing the full app", async () => {
        let fullAppConstructed = false;
        const logs: string[] = [];
        const log = vi
            .spyOn(console, "log")
            .mockImplementation((value: unknown) => {
                logs.push(String(value));
            });
        try {
            const program = createCliProgram({
                createApp: async () => {
                    fullAppConstructed = true;
                    throw new Error("auth status must not construct full app");
                },
                createAuth: () =>
                    ({
                        openAIAuth: {
                            status: async () => ({
                                authenticated: false as const,
                                storage: "keyring" as const,
                            }),
                        },
                    }) as never,
            });

            await program.parseAsync(["auth", "status"], { from: "user" });

            expect(fullAppConstructed).toBe(false);
            expect(JSON.parse(logs[0] ?? "{}")).toEqual({
                authenticated: false,
                storage: "keyring",
            });
        } finally {
            log.mockRestore();
        }
    }, 5000);
});
