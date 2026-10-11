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
};
