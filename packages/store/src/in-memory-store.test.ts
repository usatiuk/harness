import { storeContract } from "@harness/testkit/contract";
import { counterIdGenerator, fixedClock } from "@harness/testkit";
import { InMemoryStore } from "./in-memory-store.ts";

storeContract("InMemoryStore", () => new InMemoryStore(counterIdGenerator(), fixedClock()));
