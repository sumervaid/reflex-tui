import net from "node:net";

/**
 * Reflix never needs the network. Block outgoing sockets for the whole process so transcript
 * data cannot leave the machine through this process, even by accident (fetch, http, tls all
 * go through net.Socket). Child processes the user explicitly starts (`validate --run`) are separate.
 */
export function installNetworkGuard(): void {
  const blocked = function connect(): never {
    throw new Error("Reflix does not make network connections.");
  };
  net.Socket.prototype.connect = blocked as unknown as typeof net.Socket.prototype.connect;
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
