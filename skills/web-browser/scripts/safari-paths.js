import { homedir } from "node:os";
import { join } from "node:path";

export const SAFARI_DIR = join(homedir(), ".cache/agent-web/safari");
export const SOCKET_PATH = join(SAFARI_DIR, "mcp.sock");
export const PID_FILE = join(SAFARI_DIR, "daemon.pid");
export const LOG_FILE = join(SAFARI_DIR, "daemon.log");
export const SAFARIDRIVER = process.env.SAFARIDRIVER_BIN || "/usr/bin/safaridriver";
