// Dev preview: the TUI on the design fixture (mock data, simulated actions). Never shipped.
// Usage: pnpm tui:preview [-- --clock HH:MM:SS] [--view dashboard|morning|tokens|skills|workflows|router|search] [--design-state]
import { designUi } from "../fixture/design";
import { FixtureSource } from "../fixture/source";
import { runTui } from "../src/app/app";
import { VIEW_ORDER, type ViewId } from "../src/types";

const USAGE = `usage: preview [--clock HH:MM:SS] [--view ${VIEW_ORDER.join("|")}] [--design-state]
  --clock         freeze the top-bar clock (default: the wall clock)
  --view          open on this view (default: dashboard)
  --design-state  start from the state the design mockups were dumped with (selections, "refund" query)`;

function parse(argv: string[]): { clock?: string; view?: ViewId; design?: boolean } {
  const out: { clock?: string; view?: ViewId; design?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i]!.split("=", 2) as [string, string | undefined];
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--clock") {
      const v = value();
      if (!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(v)) throw new Error(`--clock wants HH:MM:SS, got ${JSON.stringify(v)}`);
      out.clock = v;
    } else if (flag === "--view") {
      const v = value();
      const view = VIEW_ORDER.find((x) => x === v) ?? VIEW_ORDER[Number(v)];
      if (!view || v === "") throw new Error(`--view wants one of ${VIEW_ORDER.join(", ")}, got ${JSON.stringify(v)}`);
      out.view = view;
    } else if (flag === "--design-state") {
      out.design = true;
    } else if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (flag !== "--") throw new Error(`unknown option ${flag}`);
  }
  return out;
}

let args: ReturnType<typeof parse>;
try {
  args = parse(process.argv.slice(2));
} catch (err) {
  console.error(`${(err as Error).message}\n${USAGE}`);
  process.exit(2);
}

runTui({
  source: new FixtureSource(),
  ...(args.clock ? { clock: args.clock } : {}),
  ...(args.view ? { initialView: args.view } : {}),
  ...(args.design ? { initialUi: { ...designUi(args.view ?? "dashboard"), ...(args.clock ? { clock: args.clock } : {}) } } : {}),
}).then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
