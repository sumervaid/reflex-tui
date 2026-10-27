import { availableParallelism, totalmem } from "node:os";
import {
  DEFAULT_MODEL,
  MINILM,
  MODELS,
  type ModelSpec,
  activeModel,
  embeddingSeconds,
  embeddingThreads,
  RUNTIME,
  fetchModel,
  fetchRuntime,
  machineIsSmall,
  memoryFits,
  modelByName,
  modelBytes,
  modelDir,
  modelStatus,
  modelVerified,
  removeModel,
  runtimeVerified,
  setActiveModel,
} from "@reflex/embeddings";
import { pathExists } from "@reflex/safety";
import { Store } from "@reflex/storage";
import { duration } from "./scan";
import { displayPath } from "@reflex/safety";
import { paths } from "@reflex/storage";
import { c, confirm, ok, out, rows, spinner, title, warn } from "../ui";
import { MODEL_HOSTS, allowHosts } from "../guard";

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(0)} MB`;
const gb = (megabytes: number) => (megabytes >= 1000 ? `${(megabytes / 1000).toFixed(1)} GB` : `${megabytes} MB`);
const languages = (m: ModelSpec) => (m.reads === "all" ? "100+ languages, mixed in one request too" : "English (Latin script) only");

/** The model a command acts on: `--model <name>`, `--light` for MiniLM, else the default. */
function chosen(opts: { model?: string; light?: boolean }): ModelSpec {
  if (opts.model) return modelByName(opts.model);
  return opts.light ? MINILM : DEFAULT_MODEL;
}

/** Sessions Reflex has stored, which a first scan with a new model embeds; undefined before any scan. */
async function storedSessions(): Promise<number | undefined> {
  if (!(await pathExists(paths.db()))) return undefined;
  const store = new Store();
  try {
    return store.contextHashes().length;
  } finally {
    store.close();
  }
}

/** What this model will cost on this machine, and whether the light model is the better fit. */
async function machineCheck(model: ModelSpec): Promise<void> {
  const threads = embeddingThreads();
  const memGB = totalmem() / 1e9;
  const sessions = await storedSessions();
  const estimate = sessions
    ? `about ${duration(embeddingSeconds(model, sessions, threads))} for your ${sessions} stored sessions`
    : `about ${duration(embeddingSeconds(model, 100, threads))} per 100 sessions`;
  rows([
    ["This machine", `${memGB.toFixed(0)} GB memory, ${availableParallelism()} cores (${threads} used for embedding)`],
    ["First scan", `${estimate}; later scans only embed new sessions (older CPUs can take up to 3x longer)`],
  ]);
  out();
  if (model !== MINILM && !memoryFits(model))
    warn(`${model.name} needs about ${(model.peakMemoryMB / 1000).toFixed(1)} GB and this machine has ${memGB.toFixed(0)} GB, so scans would skip it. Use ${c.cyan("reflex model fetch --light")} instead.`);
  else if (model !== MINILM && machineIsSmall())
    warn(`On a machine with under 8 GB of memory or fewer than 4 cores, ${c.cyan("reflex model fetch --light")} (English only, ${mb(modelBytes(MINILM))}) is much faster.`);
}

export async function modelStatusCommand(): Promise<void> {
  title("Reflex embedding models");
  const active = await activeModel(paths.models());
  for (const m of MODELS) {
    const installed = (await modelStatus(paths.models(), m)).installed;
    const state = m === active ? c.green("installed, in use") : installed ? c.green("installed") : c.dim("not installed");
    out(`${c.bold(m.name)}${m === DEFAULT_MODEL ? c.dim(" (default)") : c.dim(" (light)")}  ${state}`);
    rows([
      ["Model", m.label],
      ["Reads", languages(m)],
      ["Size", `${mb(modelBytes(m))} download, about ${gb(m.peakMemoryMB)} of memory while embedding`],
      ["Location", displayPath(modelDir(paths.models(), m))],
    ]);
    out();
  }
  out(
    active
      ? `Scans compare requests by meaning with ${active.name}, as well as by words. Switch with ${c.cyan("reflex model use <name>")}; remove with ${c.cyan("reflex model remove")}.`
      : `Optional. With a model, scans also compare requests by meaning. Install with ${c.cyan("reflex model fetch")} (or ${c.cyan("--light")} for the small English-only one).`,
  );
}

/**
 * The one command that uses the network: it downloads pinned, checksum-verified model files.
 * The network guard lets it reach Hugging Face only, during the download. No transcript data is involved.
 */
export async function modelFetch(opts: { yes?: boolean; light?: boolean; model?: string }): Promise<void> {
  const model = chosen(opts);
  title(`Download the embedding model: ${model.name}`);
  const dir = modelDir(paths.models(), model);
  const haveModel = await modelVerified(paths.models(), model);
  const haveRuntime = await runtimeVerified(paths.models());
  if (haveModel && haveRuntime) {
    await setActiveModel(paths.models(), model);
    ok(`${model.label} is already installed and verified at ${displayPath(dir)}; scans now use it.`);
    return;
  }
  if (model.reads === "all") {
    out(`Reflex can compare requests by meaning, in any language, so "the sign-in screen is really slow"`);
    out(`matches "로그인 화면이 너무 느려", "ログイン画面がすごく遅い" and "la pantalla de inicio de sesión va muy lenta".`);
    out(`This needs a local model.`);
  } else {
    out(`Reflex can compare requests by meaning, so "make the login page load faster" matches`);
    out(`"the sign-in screen is really slow". This needs a local model.`);
  }
  out();
  rows([
    ["Model", model.label],
    ["Reads", languages(model)],
    ["Download", `${haveModel ? "model already here" : `${mb(modelBytes(model))} model from huggingface.co`}; ${haveRuntime ? "runtime already here" : `${mb(RUNTIME.files.reduce((n, f) => n + f.bytes, 0))} runtime (onnxruntime-web ${RUNTIME.version}) from registry.npmjs.org`}, each verified by SHA-256`],
    ["Memory", `about ${gb(model.peakMemoryMB)} while embedding, only during a scan or \`reflex run\``],
    ["To", displayPath(dir)],
  ]);
  out();
  await machineCheck(model);
  if (model === DEFAULT_MODEL && memoryFits(model) && !machineIsSmall()) out(c.dim(`For a ${mb(modelBytes(MINILM))} English-only model instead: ${c.cyan("reflex model fetch --light")}`));
  out(c.dim("This is the only network access Reflex makes, and only for this command. Nothing is uploaded;"));
  out(c.dim("scans stay offline and the model runs locally."));
  if (!(await confirm("Download the model?", opts))) {
    out("Nothing was downloaded.");
    return;
  }
  const spin = spinner();
  spin.start("Downloading…");
  const total = modelBytes(model);
  let done = 0;
  let last = 0;
  const closeNetwork = allowHosts(MODEL_HOSTS);
  try {
    if (!haveModel)
      await fetchModel(
        paths.models(),
        model,
        (url) => fetch(url),
        (f) => spin.message(`Downloading ${f.name}…`),
        (f, bytes) => {
          const now = done + bytes;
          if (now - last > 5_000_000 || bytes === f.bytes) {
            last = now;
            spin.message(`Downloading ${f.name}: ${mb(now)} of ${mb(total)}`);
          }
          if (bytes === f.bytes) done += f.bytes;
        },
      );
    if (!haveRuntime) {
      spin.message(`Downloading the embedding runtime (onnxruntime-web ${RUNTIME.version})…`);
      await fetchRuntime(paths.models(), (url) => fetch(url));
    }
  } catch (err) {
    spin.stop("Download failed");
    throw err;
  } finally {
    closeNetwork();
  }
  await setActiveModel(paths.models(), model);
  spin.stop("Downloaded and verified");
  ok(`Installed. The next ${c.cyan("reflex scan")} will compare requests by meaning with ${model.name}${model.reads === "all" ? ", in any language" : ""}.`);
}

/** Switch scans to another installed model. Vectors each model computed stay cached. */
export async function modelUse(name: string): Promise<void> {
  const model = modelByName(name);
  if (!(await modelStatus(paths.models(), model)).installed) {
    throw new Error(`${model.name} is not installed. Download it with \`reflex model fetch${model === DEFAULT_MODEL ? "" : ` --model ${model.name}`}\`.`);
  }
  await setActiveModel(paths.models(), model);
  ok(`Scans now compare requests by meaning with ${model.name}. The next ${c.cyan("reflex scan")} embeds sessions it has not seen with it yet.`);
}

export async function modelRemove(opts: { yes?: boolean; light?: boolean; model?: string }): Promise<void> {
  const target = opts.model || opts.light ? chosen(opts) : await activeModel(paths.models());
  if (!target) {
    ok("No model is installed.");
    return;
  }
  const dir = modelDir(paths.models(), target);
  if (!(await confirm(`Remove ${target.name} from ${displayPath(dir)}?`, opts))) return;
  const existed = await removeModel(paths.models(), target);
  if (!existed) {
    ok(`${target.name} was not installed.`);
    return;
  }
  const next = await activeModel(paths.models());
  ok(next ? `Removed ${target.name}. Scans now use ${next.name}.` : `Removed ${target.name}. Scans will compare requests by words only.`);
}
