import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowHosts, installNetworkGuard } from "../src/guard";

const BLOCKED = "does not make network connections";

/** What a worker reports when it tries to open a TCP connection. */
function workerTries(make: (code: string) => Worker): Promise<string> {
  const code = `
    const { parentPort } = require("node:worker_threads");
    try { require("node:net").connect(443, "example.com").on("error", () => {}).destroy(); parentPort.postMessage("allowed"); }
    catch (e) { parentPort.postMessage(e.message); }`;
  return new Promise((resolve, reject) => {
    const w = make(code);
    w.once("message", (m) => {
      resolve(String(m));
      void w.terminate();
    });
    w.once("error", reject);
  });
}

describe("network guard", () => {
  let remove: () => void;
  beforeEach(() => {
    remove = installNetworkGuard();
  });
  afterEach(() => remove());

  it("blocks TCP and TLS", () => {
    expect(() => net.connect(443, "example.com")).toThrow(BLOCKED);
    expect(() => net.connect({ port: 443, host: "example.com" })).toThrow(BLOCKED);
    expect(() => net.connect(9, "127.0.0.1")).toThrow(BLOCKED);
    expect(() => tls.connect(443, "example.com")).toThrow(BLOCKED);
  });

  it("blocks fetch", async () => {
    await expect(fetch("https://example.com")).rejects.toThrow();
  });

  it("blocks UDP", () => {
    const socket = dgram.createSocket("udp4");
    try {
      expect(() => socket.send("x", 53, "1.1.1.1")).toThrow(BLOCKED);
      expect(() => socket.connect(53, "1.1.1.1")).toThrow(BLOCKED);
    } finally {
      socket.close();
    }
  });

  it("blocks DNS queries", () => {
    expect(() => dns.lookup("example.com", () => {})).toThrow(BLOCKED);
    expect(() => dns.resolve4("example.com", () => {})).toThrow(BLOCKED);
    expect(() => dns.promises.lookup("example.com")).toThrow(BLOCKED);
    expect(() => new dns.Resolver().resolveTxt("example.com", () => {})).toThrow(BLOCKED);
    expect(() => new dns.promises.Resolver().resolve("example.com")).toThrow(BLOCKED);
  });

  it("blocks worker threads started afterwards, from a file or inline code", async () => {
    const file = (code: string) => new Worker(new URL(`data:text/javascript,${encodeURIComponent(`import { createRequire } from "node:module"; const require = createRequire("file:///"); ${code}`)}`));
    expect(await workerTries(file)).toContain(BLOCKED);
    expect(await workerTries((code) => new Worker(code, { eval: true }))).toContain(BLOCKED);
  });

  it("lets only the allowed hosts and their subdomains through, until closed", () => {
    const close = allowHosts(["example.test"]);
    try {
      const socket = net.connect(443, "files.example.test").on("error", () => {});
      socket.destroy();
      expect(() => dns.lookup("example.test", () => {})).not.toThrow();
      expect(() => net.connect(443, "evilexample.test")).toThrow(BLOCKED);
      expect(() => net.connect(443, "example.com")).toThrow(BLOCKED);
      expect(() => dns.resolve4("example.test", () => {})).toThrow(BLOCKED);
    } finally {
      close();
    }
    expect(() => net.connect(443, "files.example.test")).toThrow(BLOCKED);
  });

  it("restores everything when removed", () => {
    remove();
    remove = () => {};
    const socket = net.connect(9, "127.0.0.1").on("error", () => {});
    socket.destroy();
  });
});
