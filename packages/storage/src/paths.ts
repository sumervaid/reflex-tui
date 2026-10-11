import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function reflixHome(): string {
  return resolve(process.env.REFLIX_HOME ?? join(homedir(), ".reflix"));
}

export const paths = {
  home: reflixHome,
  db: () => join(reflixHome(), "reflix.db"),
  skills: () => join(reflixHome(), "skills"),
};
