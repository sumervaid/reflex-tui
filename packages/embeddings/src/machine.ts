import { availableParallelism, totalmem } from "node:os";
import type { ModelSpec } from "./model";

/** More threads stopped helping past four (measured): the work is a single model run per text. */
const MAX_THREADS = 4;

/**
 * WebAssembly threads for embedding: the machine's cores up to four, or REFLEX_EMBED_THREADS.
 * Vectors are bit-for-bit the same for any thread count, so cached ones stay valid.
 */
export function embeddingThreads(env: NodeJS.ProcessEnv = process.env, cores = availableParallelism()): number {
  const asked = Number(env.REFLEX_EMBED_THREADS);
  if (Number.isInteger(asked) && asked >= 1) return Math.min(asked, 64);
  return Math.max(1, Math.min(MAX_THREADS, cores));
}

/** Memory to leave for the system and other programs while a model runs. */
const HEADROOM_MB = 3000;

/** Whether the machine has room for a model's peak memory without pushing the system into swap. */
export function memoryFits(model: ModelSpec, totalBytes = totalmem()): boolean {
  return totalBytes / 1_000_000 >= model.peakMemoryMB + HEADROOM_MB;
}

/** Below this, `reflex model fetch` recommends the light model. */
export const COMFORTABLE = { memoryGB: 8, cores: 4 };

export function machineIsSmall(totalBytes = totalmem(), cores = availableParallelism()): boolean {
  return totalBytes / 1e9 < COMFORTABLE.memoryGB - 0.5 || cores < COMFORTABLE.cores;
}

/**
 * Rough seconds to embed `sessions` sessions on this machine. Measured on Apple silicon with
 * real-length sessions; slower CPUs can take up to about three times as long.
 */
export function embeddingSeconds(model: ModelSpec, sessions: number, threads = embeddingThreads()): number {
  // Each added thread gave about 0.83 of a thread's worth (measured: 2 threads 1.95x, 4 threads 3.5x).
  const speedup = 1 + (threads - 1) * 0.83;
  return (sessions * model.secondsPerSession) / speedup;
}
