import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const TELEGRAM_ENV =
  process.env.TELEGRAM_MCP_ENV || join(homedir(), ".config/telegram-mcp.env");

export const CHANNEL_ENV =
  process.env.RECEIPT_CHANNEL_ENV || join(homedir(), ".config/receipt-channel.env");

export function channelPeer() {
  const peer = process.env.RECEIPT_CHANNEL;
  if (!peer) {
    throw new Error("RECEIPT_CHANNEL missing (set in receipt-channel.env)");
  }
  return peer;
}

export function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    // optional
  }
}

export function loadPosterEnv() {
  loadEnvFile(TELEGRAM_ENV);
  loadEnvFile(CHANNEL_ENV);
}
