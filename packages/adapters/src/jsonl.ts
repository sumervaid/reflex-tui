import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export type JsonlLine = { line: number; value?: unknown; error?: "invalid-json" | "too-large" };

/** Stream a JSONL file one record at a time. Bad lines are reported, never thrown. */
export async function* readJsonl(path: string): AsyncGenerator<JsonlLine> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const raw of rl) {
      line++;
      if (!raw.trim()) continue;
      if (raw.length > MAX_LINE_BYTES) {
        yield { line, error: "too-large" };
        continue;
      }
      try {
        yield { line, value: JSON.parse(raw) };
      } catch {
        yield { line, error: "invalid-json" };
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}
