import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import threads, { type WorkerOptions } from "node:worker_threads";

const MESSAGE = "Reflex does not make network connections";

/** Hosts `reflex model fetch` may reach, with their subdomains: Hugging Face and the CDNs its downloads redirect to. */
export const MODEL_HOSTS = ["huggingface.co", "hf.co"];

/** DNS functions that send queries. `lookup` is also how net.Socket resolves the host it connects to. */
const DNS_QUERIES = /^(lookup|lookupService|resolve\w*|reverse)$/;

/**
 * The same block for worker threads, which have their own copies of these modules. Workers never
 * need the network, so nothing is allowed there.
 */
const WORKER_GUARD = `{
  const blocked = () => { throw new Error(${JSON.stringify(`${MESSAGE}.`)}); };
  const get = process.getBuiltinModule;
  get("node:net").Socket.prototype.connect = blocked;
  const udp = get("node:dgram").Socket.prototype;
  udp.send = udp.connect = blocked;
  const dns = get("node:dns");
  for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype])
    for (const key of Object.getOwnPropertyNames(target))
      if (${DNS_QUERIES}.test(key) && typeof target[key] === "function") target[key] = blocked;
}`;

let allowed: readonly string[] = [];

function hostAllowed(host: unknown): host is string {
  if (typeof host !== "string") return false;
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((a) => h === a || h.endsWith(`.${a}`));
}

/** The host of a net.Socket#connect call: `(options)`, `(port, host?)`, or the `[options, cb]` Node passes itself. A local socket path has none. */
function connectHost(args: unknown[]): unknown {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === "object" && first !== null) {
    const o = first as { host?: unknown; path?: unknown };
    return o.path === undefined ? (o.host ?? "localhost") : undefined;
  }
  if (typeof first === "number" || /^\d+$/.test(String(first))) return typeof args[1] === "string" ? args[1] : "localhost";
  return undefined;
}

const refuse = (host: unknown): never => {
  throw new Error(typeof host === "string" ? `${MESSAGE} (blocked ${host}).` : `${MESSAGE}.`);
};

type Fn = (...args: unknown[]) => unknown;

/**
 * Reflex never needs the network, except to download a model when asked (see `allowHosts`). Block
 * outgoing connections for the whole process so transcript data cannot leave the machine through
 * it, even by accident: TCP and TLS (which fetch and http use), UDP, DNS queries, and the same in
 * every worker thread started afterwards. Child processes the user explicitly starts
 * (`validate --run`, `run`, `bench`) are separate. Returns a function that removes the guard.
 */
export function installNetworkGuard(): () => void {
  const undo: Array<() => void> = [];
  const patch = (target: object, key: string, make: (original: Fn) => Fn) => {
    const t = target as Record<string, unknown>;
    const original = t[key] as Fn;
    t[key] = make(original);
    undo.push(() => (t[key] = original));
  };

  patch(net.Socket.prototype, "connect", (original) =>
    function connect(this: unknown, ...args: unknown[]) {
      const host = connectHost(args);
      return hostAllowed(host) ? original.apply(this, args) : refuse(host);
    },
  );
  for (const key of ["send", "connect"]) patch(dgram.Socket.prototype, key, () => () => refuse(undefined));
  for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const key of Object.getOwnPropertyNames(target)) {
      if (!DNS_QUERIES.test(key) || typeof (target as Record<string, unknown>)[key] !== "function") continue;
      patch(target, key, (original) =>
        key === "lookup"
          ? function lookup(this: unknown, ...args: unknown[]) {
              return hostAllowed(args[0]) ? original.apply(this, args) : refuse(args[0]);
            }
          : () => refuse(undefined),
      );
    }
  }

  const Base = threads.Worker;
  class GuardedWorker extends Base {
    constructor(filename: string | URL, options: WorkerOptions = {}) {
      // Inline code runs without --import, so the guard goes in front of it.
      const inline = options.eval === true && typeof filename === "string";
      const guard = ["--import", `data:text/javascript,${encodeURIComponent(WORKER_GUARD)}`];
      super(inline ? `${WORKER_GUARD}\n${filename}` : filename, inline ? options : { ...options, execArgv: [...(options.execArgv ?? process.execArgv), ...guard] });
    }
  }
  patch(threads, "Worker", () => GuardedWorker as unknown as Fn);
  syncBuiltinESMExports();

  return () => {
    for (const fn of undo.reverse()) fn();
    syncBuiltinESMExports();
  };
}

/**
 * Let this process reach `hosts` and their subdomains until the returned function is called; only
 * `reflex model fetch` does. With NODE_USE_ENV_PROXY set, fetch connects through the proxy, so the
 * proxy's host is allowed too.
 */
export function allowHosts(hosts: string[]): () => void {
  const before = allowed;
  allowed = [...before, ...hosts, ...proxyHosts()];
  return () => {
    allowed = before;
  };
}

function proxyHosts(): string[] {
  if (!process.env.NODE_USE_ENV_PROXY) return [];
  const url = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  try {
    return url ? [new URL(url).hostname.toLowerCase()] : [];
  } catch {
    return [];
  }
}

/** node:sqlite prints an ExperimentalWarning on Node 22/24; keep every other warning. */
export function quietSqliteWarning(): void {
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
    for (const l of listeners) l(w);
  });
}
