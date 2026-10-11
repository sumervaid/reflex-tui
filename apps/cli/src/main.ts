import { installNetworkGuard, quietSqliteWarning } from "./guard";
quietSqliteWarning();
// `reflex model fetch` downloads the optional embedding model and is the only command allowed to
// use the network; it never reads transcripts. Every other command runs with sockets blocked.
const fetchingModel = process.argv[2] === "model" && process.argv[3] === "fetch";
if (!fetchingModel) installNetworkGuard();
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

import { Command, Option } from "commander";
import type { SourceId } from "@reflex/core";
import { fail } from "./ui";
import { parseDays, scan } from "./commands/scan";
import { approve, evidence, reject, show, suggest } from "./commands/review";
import { explain, installCommand, listSkills, showSkill, validate } from "./commands/skills";
import { doctor, reset, sessions, stats } from "./commands/misc";
import { modelFetch, modelRemove, modelStatusCommand } from "./commands/model";
import { impact } from "./commands/impact";
import { tui } from "./commands/tui";

function run<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      if (process.env.REFLEX_DEBUG === "1" && err instanceof Error) process.stderr.write(`${err.stack}\n`);
      process.exitCode = 1;
    }
  };
}

const program = new Command();
program
  .name("reflex")
  .description("Find workflows you keep re-teaching Claude Code, Codex and Cursor, and turn proven repeats into reusable skills. Everything runs locally.")
  .version("0.3.1")
  .allowExcessArguments()
  .action(
    run(async () => {
      if (program.args.length) program.error(`error: unknown command '${program.args[0]}'. See \`reflex --help\`.`);
      if (process.stdin.isTTY && process.stdout.isTTY) await tui();
      else program.help();
    }),
  );

program.command("doctor").description("check the environment and detected history locations").action(run(doctor));

program
  .command("scan")
  .description("read recent coding-agent history (asks first) and store redacted workflow traces")
  .option("--days <n>", "history window in days", "7")
  .option("--claude-dir <dir>", "read Claude Code transcripts from this directory")
  .option("--codex-dir <dir>", "read Codex rollouts from this directory")
  .option("--cursor-dir <dir>", "read Cursor agent transcripts from this directory (default ~/.cursor/projects)")
  .addOption(new Option("--source <source...>", "only read these sources (repeatable)").choices(["claude-code", "codex", "cursor"]))
  .option("-y, --yes", "consent to reading the detected history without prompting")
  .option("--full", "read every transcript again instead of reusing unchanged ones")
  .action(
    run(async (o: { days: string; claudeDir?: string; codexDir?: string; cursorDir?: string; source?: SourceId[]; yes?: boolean; full?: boolean }) =>
      scan({ ...o, days: parseDays(o.days) }),
    ),
  );

program.command("sessions").description("list sessions from the last scan (redacted)").action(run(sessions));

program
  .command("suggest")
  .description("detect repeated workflows and review them")
  .option("--all", "include rejected suggestions")
  .option("--no-interactive", "print suggestions without the review prompt")
  .action(run(suggest));

program.command("show <suggestion>").description("show a suggestion in detail (number or name)").action(run(show));
program.command("evidence <suggestion>").description("show the sessions behind a suggestion").action(run(evidence));
program
  .command("approve <suggestion>")
  .description("generate a skill from a suggestion into ~/.reflex/skills")
  .option("-y, --yes", "approve without prompting")
  .option("--no-install", "do not offer installation afterwards")
  .action(run(approve));
program.command("reject <suggestion>").description("stop suggesting a workflow").action(run(reject));

program.command("skills").description("list generated skills and where they are installed").action(run(listSkills));
program.command("show-skill <skill>").description("print a generated SKILL.md").action(run(showSkill));
program
  .command("install <skill>")
  .description("install a generated skill into Claude Code, Codex and/or Cursor (asks per target)")
  .addOption(new Option("--target <target...>", "install target").choices(["claude-code", "codex", "cursor"]))
  .option("--as <name>", "install under a different name")
  .option("-y, --yes", "consent to writing the skill file without prompting")
  .action(run(installCommand));
program.command("explain <skill>").description("show why a skill exists and where it came from").action(run(explain));
program
  .command("validate <skill>")
  .description("check a skill and prepare a fresh task to prove it works")
  .option("--run", "run a fresh, non-persistent Claude Code session on the task (asks first)")
  .option("-y, --yes", "consent without prompting")
  .action(run(validate));

program
  .command("tui")
  .description("open the terminal UI (also what `reflex` alone opens): sessions, tokens, skills, workflows and search")
  .action(run(tui));

const model = program.command("model").description("optional local embedding model for matching requests by meaning");
model.command("status", { isDefault: true }).description("show whether the model is installed").action(run(modelStatusCommand));
model
  .command("fetch")
  .description("download the pinned model (about 23 MB; the only command that uses the network)")
  .option("-y, --yes", "download without prompting")
  .action(run(modelFetch));
model.command("remove").description("delete the downloaded model").option("-y, --yes", "remove without prompting").action(run(modelRemove));

program.command("impact [skill]").description("compare a workflow's tokens and tool calls before and after its skill").action(run(impact));
program.command("stats").description("defensible counts from local data").action(run(stats));
program
  .command("reset")
  .description("delete Reflex's own local data (not installed skills)")
  .option("-y, --yes", "consent without prompting")
  .action(run(reset));

await program.parseAsync(process.argv);
