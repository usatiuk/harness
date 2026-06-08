import { MemorySecretStore } from "./memory.ts";
import { secretStoreContract } from "./secret-store.contract.ts";

secretStoreContract("MemorySecretStore", () => new MemorySecretStore());
