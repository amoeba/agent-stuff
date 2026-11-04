#!/usr/bin/env node

/**
 * Keeps one `safaridriver --mcp` session alive and exposes it on a unix
 * socket so short-lived CLI calls (safari.js) share one Safari window,
 * tab state, and console/network buffers.
 *
 * Protocol (newline-delimited JSON over the socket):
 *   -> {"method": "tools/call", "params": {...}}   (any MCP method)
 *   <- {"result": ...} | {"error": {...}}
 *
 * Normally started by `safari.js start`, not directly.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { SAFARI_DIR, SOCKET_PATH, PID_FILE, SAFARIDRIVER } from "./safari-paths.js";

const IDLE_TIMEOUT_MS = Number(process.env.SAFARI_IDLE_TIMEOUT_MS || 30 * 60 * 1000);
const CALL_TIMEOUT_MS = Number(process.env.SAFARI_CALL_TIMEOUT_MS || 120 * 1000);

mkdirSync(SAFARI_DIR, { recursive: true });
if (existsSync(SOCKET_PATH)) rmSync(SOCKET_PATH, { force: true });

const driver = spawn(SAFARIDRIVER, ["--mcp"], { stdio: ["pipe", "pipe", "inherit"] });

let nextId = 0;
const pending = new Map();
let buf = "";

driver.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("daemon: non-JSON from safaridriver:", line.slice(0, 200));
      continue;
    }
    const p = msg.id !== undefined ? pending.get(msg.id) : null;
    if (!p) continue;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg);
  }
});

function rpc(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ error: { code: -1, message: `timeout after ${CALL_TIMEOUT_MS}ms: ${method}` } });
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    driver.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function shutdown(code = 0) {
  try { rmSync(SOCKET_PATH, { force: true }); } catch {}
  try { rmSync(PID_FILE, { force: true }); } catch {}
  try { driver.kill(); } catch {}
  process.exit(code);
}

driver.on("exit", (code) => {
  console.error(`daemon: safaridriver exited (${code})`);
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.resolve({ error: { code: -1, message: "safaridriver exited" } });
  }
  shutdown(1);
});
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "pi-web-browser", version: "1.0.0" },
});
if (init.error) {
  console.error("daemon: initialize failed:", init.error.message);
  shutdown(1);
}
driver.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

let idleTimer;
const resetIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.error("daemon: idle timeout, exiting");
    shutdown(0);
  }, IDLE_TIMEOUT_MS);
};
resetIdle();

const server = createServer((sock) => {
  let inbuf = "";
  sock.on("data", async (chunk) => {
    inbuf += chunk;
    let i;
    while ((i = inbuf.indexOf("\n")) >= 0) {
      const line = inbuf.slice(0, i);
      inbuf = inbuf.slice(i + 1);
      resetIdle();
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        sock.write(JSON.stringify({ error: { message: "bad request JSON" } }) + "\n");
        continue;
      }
      if (req.method === "daemon/stop") {
        sock.end(JSON.stringify({ result: "stopping" }) + "\n");
        setTimeout(() => shutdown(0), 50);
        return;
      }
      const res = await rpc(req.method, req.params || {});
      sock.write(JSON.stringify(res.error ? { error: res.error } : { result: res.result }) + "\n");
    }
  });
  sock.on("error", () => {});
});

server.listen(SOCKET_PATH, () => {
  writeFileSync(PID_FILE, String(process.pid));
  console.error(`daemon: listening on ${SOCKET_PATH}`);
});
