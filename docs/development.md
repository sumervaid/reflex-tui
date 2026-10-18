# Development

From source (needs pnpm):

```sh
pnpm install && pnpm build && pnpm test
alias reflex="node $PWD/apps/cli/dist/reflex.js"
```

```sh
pnpm build       # bundles the CLI to apps/cli/dist/reflex.js
pnpm test        # vitest across all packages
pnpm typecheck
pnpm lint
```

The monorepo uses pnpm workspaces and Turborepo with strict TypeScript, Zod for untrusted records,
and built-in `node:sqlite` for storage, so there are no native dependencies. The optional embedding
model runs on onnxruntime-web's WebAssembly backend for the same reason. Packages live in
`packages/*`; the CLI in `apps/cli`. `packages/test-fixtures` holds synthetic transcripts used only
by the tests; it is not part of the published CLI.
