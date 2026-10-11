import { MODEL, fetchModel, modelBytes, modelStatus, modelVerified, removeModel } from "@reflex/embeddings";
import { displayPath } from "@reflex/safety";
import { paths } from "@reflex/storage";
import { c, confirm, ok, out, rows, spinner, title } from "../ui";

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

export async function modelStatusCommand(): Promise<void> {
  title("Reflex embedding model");
  const status = await modelStatus(paths.models());
  rows([
    ["Model", MODEL.label],
    ["Location", displayPath(status.dir)],
    ["Status", status.installed ? c.green("installed") : c.dim("not installed")],
  ]);
  out();
  out(
    status.installed
      ? "Scans compare requests by meaning as well as by words. Remove it with `reflex model remove`."
      : `Optional. With it, scans also compare requests by meaning. Install with ${c.cyan("reflex model fetch")}.`,
  );
}

/**
 * The one command that uses the network: it downloads pinned, checksum-verified model files.
 * main.ts leaves the network guard off for this command only. No transcript data is involved.
 */
export async function modelFetch(opts: { yes?: boolean }): Promise<void> {
  title("Download the embedding model");
  const status = await modelStatus(paths.models());
  if (await modelVerified(paths.models())) {
    ok(`${MODEL.label} is already installed and verified at ${displayPath(status.dir)}.`);
    return;
  }
  out(`Reflex can compare requests by meaning, so "make the login page load faster" matches`);
  out(`"the sign-in screen is really slow". This needs a small local model.`);
  out();
  rows([
    ["Model", `${MODEL.label}, ${mb(modelBytes())}`],
    ["From", "huggingface.co (files pinned to one revision, verified by SHA-256)"],
    ["To", displayPath(status.dir)],
  ]);
  out();
  out(c.dim("This is the only network access Reflex makes, and only for this command. Nothing is uploaded;"));
  out(c.dim("scans stay offline and the model runs locally."));
  if (!(await confirm("Download the model?", opts))) {
    out("Nothing was downloaded.");
    return;
  }
  const spin = spinner();
  spin.start("Downloading…");
  try {
    await fetchModel(paths.models(), (url) => fetch(url), (f) => spin.message(`Downloading ${f.name} (${mb(f.bytes)})…`));
  } catch (err) {
    spin.stop("Download failed");
    throw err;
  }
  spin.stop("Downloaded and verified");
  ok(`Installed. The next ${c.cyan("reflex scan")} will compare requests by meaning.`);
}

export async function modelRemove(opts: { yes?: boolean }): Promise<void> {
  const status = await modelStatus(paths.models());
  if (!(await confirm(`Remove the embedding model from ${displayPath(status.dir)}?`, opts))) return;
  const existed = await removeModel(paths.models());
  ok(existed ? "Removed. Scans will compare requests by words only." : "No model was installed.");
}
