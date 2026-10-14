import { MODEL } from "./model";
import { REFERENCE_MEAN_MINILM } from "./reference-mean";

/**
 * Generic coding requests across many kinds of task. Their mean vector is the direction every
 * coding request shares ("this is about code"). Comparing sessions after removing it leaves what
 * tells tasks apart: on the labeled evaluation set, same-task vs different-task ranking improves and
 * clustering finds more clean workflows. A fixed reference is used rather than the mean of the
 * user's own history, which would erase real meaning when a history holds only a few kinds of task.
 */
export const REFERENCE_REQUESTS = [
  "fix the failing build",
  "add a button to export the table as CSV",
  "why is this endpoint returning 500",
  "refactor the payment module into smaller files",
  "update the dependencies to their latest versions",
  "write a script that cleans up old log files",
  "explain how authentication works in this app",
  "add pagination to the users list",
  "the docker image is too big, make it smaller",
  "set up linting and formatting",
  "migrate this component from class to hooks",
  "add caching to the product API",
  "review my changes before I open a pull request",
  "the app is slow on startup",
  "add a dark theme",
  "implement password reset by email",
  "fix the typo in the header",
  "add logging around the checkout flow",
  "convert the config from JSON to YAML",
  "make the tests run in parallel",
  "upgrade to the new major version of the framework",
  "add input validation to the signup form",
  "debug why the websocket disconnects",
  "write documentation for the CLI",
  "create a database seed script",
  "remove dead code in the utils folder",
  "add retry logic to the HTTP client",
  "set up a GitHub Actions workflow for releases",
  "translate the error messages",
  "add a health check endpoint",
  "investigate the memory leak in the worker",
  "rename the project in all config files",
  "add type definitions for the API responses",
  "make the layout responsive on mobile",
  "deploy the staging environment",
  "add rate limiting to the login route",
  "summarize what changed in the last release",
  "split the monolith into two services",
  "add unit tests for the parser",
  "fix the race condition when saving drafts",
];

/** Mean of the reference requests' vectors per model, precomputed (see test/reference.test.ts). */
const REFERENCE_MEANS: Record<string, readonly number[]> = { [MODEL.id]: REFERENCE_MEAN_MINILM };

export function meanVector(vectors: ArrayLike<number>[]): Float32Array {
  const mean = new Float32Array(vectors[0]?.length ?? 0);
  for (const v of vectors) for (let k = 0; k < mean.length; k++) mean[k]! += v[k]! / vectors.length;
  return mean;
}

/** Subtract a model's reference mean and rescale to unit length. Unknown models pass through unchanged. */
export function centerOnReference(v: ArrayLike<number>, model: string = MODEL.id): Float32Array {
  const mean = REFERENCE_MEANS[model];
  if (!mean || mean.length !== v.length) return Float32Array.from(v);
  const c = Float32Array.from(v, (x, k) => x - mean[k]!);
  let norm = 0;
  for (const x of c) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let k = 0; k < c.length; k++) c[k]! /= norm;
  return c;
}
