import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Licenses a bundled package may have. Anything else fails the build. */
export const ALLOWED_LICENSES = ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0"];

/**
 * Packages whose npm tarball has no license file: the copyright line their repository's license
 * gives, used with the standard text of the license their package.json names.
 */
const NO_LICENSE_FILE: Record<string, { copyright: string; note?: string }> = {
  "onnxruntime-common": { copyright: "Copyright (c) Microsoft Corporation." },
  "onnxruntime-web": {
    copyright: "Copyright (c) Microsoft Corporation.",
    note: "ort-wasm-simd-threaded.wasm is ONNX Runtime compiled to WebAssembly. The third-party components built into it are listed in https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt.",
  },
  "stopwords-iso": { copyright: "Copyright (c) Gene Diaz" },
};

const MIT = (copyright: string) => `MIT License

${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

export type BundledPackage = { name: string; version: string; license: string; dir: string };

/** The npm packages esbuild put into the bundle, from the metafile's input paths (relative to `cwd`). */
export function bundledPackages(inputs: string[], cwd: string): BundledPackage[] {
  const dirs = new Map<string, string>();
  for (const input of inputs) {
    const i = input.lastIndexOf("node_modules/");
    if (i < 0) continue;
    const parts = input.slice(i + "node_modules/".length).split("/");
    const name = parts.slice(0, parts[0]!.startsWith("@") ? 2 : 1).join("/");
    dirs.set(name, join(cwd, input.slice(0, i + "node_modules/".length), name));
  }
  return [...dirs]
    .map(([name, dir]) => {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; license?: unknown };
      return { name, version: pkg.version, license: typeof pkg.license === "string" ? pkg.license : "UNKNOWN", dir };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const filesLike = (dir: string, re: RegExp): string[] =>
  readdirSync(dir)
    .filter((f) => re.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8").trim());

/**
 * THIRD_PARTY_NOTICES.md for the bundled packages: each one's license file and any NOTICE file.
 * Throws when a package's license is not on the allowlist, or there is no license text for it.
 */
export function thirdPartyNotices(packages: BundledPackage[]): string {
  const problems: string[] = [];
  const sections = packages.map((p) => {
    if (!ALLOWED_LICENSES.includes(p.license)) problems.push(`${p.name}@${p.version} is licensed ${p.license}, which is not on the allowlist (${ALLOWED_LICENSES.join(", ")}).`);
    const files = filesLike(p.dir, /^(licen[sc]e|copying)(\.(md|txt))?$/i);
    const notice = filesLike(p.dir, /^notice(\.(md|txt))?$/i);
    const known = NO_LICENSE_FILE[p.name];
    let text = files.join("\n\n");
    if (!text && known && p.license === "MIT") text = MIT(known.copyright);
    if (!text) problems.push(`${p.name}@${p.version} has no license file; add its copyright to NO_LICENSE_FILE in apps/cli/build/notices.ts.`);
    return [`## ${p.name} ${p.version} (${p.license})`, known?.note, text, ...notice].filter(Boolean).join("\n\n");
  });
  if (problems.length) throw new Error(problems.join("\n"));
  return `# Third-party notices

The reflex-skills package bundles the following packages. Their licenses and notices follow.

${sections.join("\n\n")}
`;
}

/** The notices for a build, from the esbuild metafile it wrote. */
export function noticesFromMetafile(metafile: string, cwd: string): string {
  const inputs = Object.keys((JSON.parse(readFileSync(metafile, "utf8")) as { inputs: Record<string, unknown> }).inputs);
  return thirdPartyNotices(bundledPackages(inputs, cwd));
}
