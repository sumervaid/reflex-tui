import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function reflexHome(): string {
  return resolve(process.env.REFLEX_HOME ?? join(homedir(), ".reflex"));
}

export const paths = {
  home: reflexHome,
  db: () => join(reflexHome(), "reflex.db"),
  skills: () => join(reflexHome(), "skills"),
  models: () => join(reflexHome(), "models"),
  /** Token counts Reflex's Cursor hook records (`reflex cursor-usage on`). */
  cursorUsage: () => join(reflexHome(), "cursor-usage.jsonl"),
  hooks: () => join(reflexHome(), "hooks"),
  /** Model prices the user adds or corrects, used ahead of the built-in ones. */
  prices: () => join(reflexHome(), "prices.json"),
};
