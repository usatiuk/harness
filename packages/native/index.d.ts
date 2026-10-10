/** Native process-owned use protection. Retain the object for the consumer lifetime. */
export interface NativeCacheUse {
  /** Release only after all consumers have physically exited. Idempotent. */
  close(): void;
}
export const CacheUse: new (home: string) => NativeCacheUse;
export interface NativeLifecycleLock {
  /** false is ordinary contention, with no PID or stale-lease inference. */
  tryAcquire(): boolean;
  close(): void;
}
export const LifecycleLock: new (home: string) => NativeLifecycleLock;
/** Verifies original signed bytes with the compiled project key, returning typed JSON metadata. */
export function verifyRelease(bytes: Buffer, signature: string): string;
/** Verifies exact updater bytes with the same compiled project key. */
export function verifyArtifactSignature(bytes: Buffer, signature: string): void;
export interface NativePipeListener {
  /** null classifies a peer that left before admission. */
  accept(): Promise<number | null>;
  /** The adapter also awaits its outstanding accept before declaring physical closure. */
  close(): Promise<void>;
}
export const PipeListener: (new (name: string) => NativePipeListener) | undefined;
/** Transfers a descriptor from accept into a public Node socket exactly once. */
export function adoptPipe(descriptor: number): import("node:net").Socket;
