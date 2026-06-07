import { MemoryHarnessStore } from "../src/index.ts";
import { runHarnessStoreContract } from "./store-contract.ts";

runHarnessStoreContract("MemoryHarnessStore", () => ({
    store: new MemoryHarnessStore(),
}));
