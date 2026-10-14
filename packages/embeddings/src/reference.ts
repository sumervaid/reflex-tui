import { BGE_M3, MINILM, type ModelSpec } from "./model";
import { REFERENCE_MEAN_BGE_M3, REFERENCE_MEAN_MINILM } from "./reference-mean";

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

/**
 * More generic requests in other languages, for a model that reads them: its reference mean then
 * covers the shared direction of coding requests in every language, not only English.
 */
export const REFERENCE_REQUESTS_OTHER_LANGUAGES = [
  "빌드 실패하는 거 고쳐줘",
  "이 엔드포인트가 왜 500을 반환하는지 확인해줘",
  "의존성 패키지 최신으로 올려줘",
  "앱 시작 속도가 너무 느려",
  "회원가입 폼에 입력 검증 추가해줘",
  "웹소켓 연결이 끊기는 이유 찾아줘",
  "ビルドが失敗するので直して",
  "このAPIがなぜ500を返すのか調べて",
  "依存関係を最新版に更新して",
  "アプリの起動が遅すぎる",
  "サインアップフォームに入力チェックを追加して",
  "修复构建失败的问题",
  "看看这个接口为什么返回 500",
  "把依赖升级到最新版本",
  "应用启动太慢了",
  "给注册表单加上输入校验",
  "arregla el build que está fallando",
  "por qué este endpoint devuelve 500",
  "actualiza las dependencias a la última versión",
  "la app tarda mucho en arrancar",
  "behebe den fehlschlagenden Build",
  "warum gibt dieser Endpoint 500 zurück",
  "aktualisiere die Abhängigkeiten",
  "die App startet zu langsam",
  "corrige le build qui échoue",
  "pourquoi cet endpoint renvoie une 500",
  "mets à jour les dépendances",
  "l'application démarre trop lentement",
];

/** The reference requests for a model: English only for a model that reads only Latin script. */
export function referenceRequests(model: ModelSpec): string[] {
  return model.reads === "all" ? [...REFERENCE_REQUESTS, ...REFERENCE_REQUESTS_OTHER_LANGUAGES] : REFERENCE_REQUESTS;
}

/** Mean of each model's reference requests' vectors, precomputed (see test/reference.test.ts). */
const REFERENCE_MEANS: Record<string, readonly number[]> = { [MINILM.id]: REFERENCE_MEAN_MINILM, [BGE_M3.id]: REFERENCE_MEAN_BGE_M3 };

export function meanVector(vectors: ArrayLike<number>[]): Float32Array {
  const mean = new Float32Array(vectors[0]?.length ?? 0);
  for (const v of vectors) for (let k = 0; k < mean.length; k++) mean[k]! += v[k]! / vectors.length;
  return mean;
}

/** Subtract a model's reference mean and rescale to unit length. A model without one passes through unchanged. */
export function centerOnReference(v: ArrayLike<number>, model: ModelSpec): Float32Array {
  const mean = REFERENCE_MEANS[model.id];
  if (!mean || mean.length !== v.length) return Float32Array.from(v);
  const c = Float32Array.from(v, (x, k) => x - mean[k]!);
  let norm = 0;
  for (const x of c) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let k = 0; k < c.length; k++) c[k]! /= norm;
  return c;
}
