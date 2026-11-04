#!/usr/bin/env node

/**
 * CLI for Safari's built-in MCP server (safaridriver --mcp), via a
 * persistent background daemon so calls share one Safari session.
 *
 *   safari.js start | stop | status
 *   safari.js tools [tool_name]
 *   safari.js <tool_name> ['{"json":"args"}'] [--key value ...]
 */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SAFARI_DIR, SOCKET_PATH, LOG_FILE, SAFARIDRIVER } from "./safari-paths.js";

const here = dirname(fileURLToPath(import.meta.url));

function usage(code = 1) {
  console.log(`Usage:
  safari.js start                 Start the Safari session (opens agent window)
  safari.js stop                  End the session
  safari.js status                Is a session running?
  safari.js tools [name]          List tools, or show one tool's input schema
  safari.js <tool> [json] [--key value ...]

Examples:
  safari.js navigate_to_url --url https://example.com
  safari.js get_page_content --format markdown --region entire_page
  safari.js page_interactions '{"interactions":[{"type":"click","node":42,"purpose":"open menu"}]}'
  safari.js evaluate_javascript --expression 'return document.title'
  safari.js list_network_requests --clear true`);
  process.exit(code);
}

function request(method, params, timeoutMs = 130_000) {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET_PATH);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify({ method, params }) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      clearTimeout(timer);
      sock.end();
      try {
        resolve(JSON.parse(buf.slice(0, i)));
      } catch (e) {
        reject(e);
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function isRunning() {
  if (!existsSync(SOCKET_PATH)) return false;
  try {
    const res = await request("ping", {}, 3000);
    // safaridriver answers ping with {} (or method-not-found); either way it's alive.
    return Boolean(res);
  } catch {
    return false;
  }
}

function tailLog(n = 15) {
  try {
    return readFileSync(LOG_FILE, "utf8").trim().split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
}

async function callTool(name, args) {
  const res = await request("tools/call", { name, arguments: args });
  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  return res.result;
}

async function start() {
  if (await isRunning()) return { reused: true };
  if (!existsSync(SAFARIDRIVER)) {
    throw new Error(`${SAFARIDRIVER} not found (Safari 27+ on macOS required)`);
  }
  mkdirSync(SAFARI_DIR, { recursive: true });
  const log = openSync(LOG_FILE, "w"); // fresh log per session so errors are relevant
  const child = spawn(process.execPath, [join(here, "safari-daemon.js")], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await isRunning()) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!(await isRunning())) {
    throw new Error(`Safari daemon failed to start.\n${tailLog()}`);
  }

  // Open the agent window now. Network requests from the first navigation of
  // a session aren't captured, so burn it on about:blank and clear buffers.
  const nav = await callTool("navigate_to_url", { url: "about:blank" });
  if (nav.isError) {
    await request("daemon/stop", {}).catch(() => {});
    throw new Error(
      `Safari refused automation: ${textOf(nav)}\n` +
        `Enable Safari > Settings > Developer > "Allow remote automation and external agents".`,
    );
  }
  await callTool("list_network_requests", { clear: true });
  await callTool("browser_console_messages", { clear: true });
  return { reused: false };
}

function textOf(result) {
  return (result.content || [])
    .map((c) => (c.type === "text" ? c.text : `[${c.type}${c.mimeType ? " " + c.mimeType : ""}]`))
    .join("\n");
}

function parseValue(v) {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function parseArgs(argv) {
  let args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        // Keep URLs/expressions as strings even if they look like JSON numbers etc.
        args[key] = key === "url" || key === "expression" || key === "text" ? next : parseValue(next);
        i++;
      }
    } else if (a.trim().startsWith("{")) {
      args = { ...args, ...JSON.parse(a) };
    } else {
      throw new Error(`Unexpected argument: ${a} (use --key value or a JSON object)`);
    }
  }
  return args;
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "-h" || cmd === "--help") usage(cmd ? 0 : 1);

try {
  if (cmd === "start") {
    const { reused } = await start();
    console.log(reused ? "✓ Safari session already running (reusing)" : "✓ Safari session started");
  } else if (cmd === "stop") {
    if (await isRunning()) {
      await request("daemon/stop", {});
      console.log("✓ Safari session stopped");
    } else {
      console.log("Safari session not running");
    }
  } else if (cmd === "status") {
    const up = await isRunning();
    console.log(up ? "running" : "not running");
    process.exit(up ? 0 : 1);
  } else if (cmd === "tools") {
    await start();
    const res = await request("tools/list", {});
    if (res.error) throw new Error(res.error.message);
    const tools = res.result.tools;
    if (rest[0]) {
      const t = tools.find((t) => t.name === rest[0]);
      if (!t) throw new Error(`No tool named ${rest[0]}`);
      console.log(`${t.name}\n\n${t.description}\n\n${JSON.stringify(t.inputSchema, null, 2)}`);
    } else {
      for (const t of tools) {
        console.log(`${t.name}: ${(t.description || "").split("\n")[0].slice(0, 140)}`);
      }
    }
  } else {
    const args = parseArgs(rest);
    await start();
    const result = await callTool(cmd, args);
    console.log(textOf(result));
    if (result.isError) process.exit(1);
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
