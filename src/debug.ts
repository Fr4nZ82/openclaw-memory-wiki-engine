/**
 * debug.ts — Centralized debug logging for Memory Wiki Engine
 *
 * Features:
 *   - File-based logging to /tmp/mwe-debug.log (no truncation)
 *   - Console mirroring (shows on Palantír)
 *   - Simple rotation: max 2MB, 1 backup file
 *   - Scoped loggers per module ([classifier], [capture], [recall], etc.)
 *   - Toggle via MWE_DEBUG env var or setDebugEnabled()
 *
 * Usage:
 *   import { dbg } from "./debug";
 *   const log = dbg("classifier");
 *   log("something happened");
 *   log("full gemini response:\n" + response);  // no truncation in file
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const LOG_PATH = "/tmp/mwe-debug.log";
const BACKUP_PATH = "/tmp/mwe-debug.log.1";
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const CONSOLE_TRUNCATE = 200; // max chars shown on Palantír per line

/** Debug mode — active by default, disable with MWE_DEBUG=0 */
let debugEnabled: boolean = process.env.MWE_DEBUG !== "0";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enable or disable debug logging at runtime.
 * Call setDebugEnabled(false) to silence all debug output.
 */
export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

/** Returns current debug state */
export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/**
 * Creates a scoped debug logger for a module.
 *
 * @param scope - Module name (e.g. "classifier", "capture", "recall")
 * @returns A function that logs messages with the scope prefix
 *
 * @example
 * const log = dbg("classifier");
 * log("resolving API key...");
 * // Console: [MWE:classifier] resolving API key...
 * // File:    [2026-04-27T01:23:45.678Z] [classifier] resolving API key...
 */
export function dbg(scope: string): (msg: string) => void {
  return (msg: string) => {
    if (!debugEnabled) return;

    const ts = new Date().toISOString();

    // Always write full content to file (no truncation)
    const fileLine = `[${ts}] [${scope}] ${msg}\n`;
    writeToFile(fileLine);

    // Console: truncate long messages but show the scope
    const lines = msg.split("\n");
    if (lines.length > 1) {
      // Multi-line: show first line + line count
      const first = lines[0].substring(0, CONSOLE_TRUNCATE);
      console.log(`[MWE:${scope}] ${first} (+${lines.length - 1} lines, see /tmp/mwe-debug.log)`);
    } else {
      const truncated = msg.length > CONSOLE_TRUNCATE
        ? msg.substring(0, CONSOLE_TRUNCATE) + "..."
        : msg;
      console.log(`[MWE:${scope}] ${truncated}`);
    }
  };
}

// ---------------------------------------------------------------------------
// File I/O with rotation
// ---------------------------------------------------------------------------

function writeToFile(content: string): void {
  try {
    // Check rotation
    try {
      const stats = fs.statSync(LOG_PATH);
      if (stats.size > MAX_FILE_SIZE) {
        // Rotate: current → backup (overwrite old backup)
        try { fs.copyFileSync(LOG_PATH, BACKUP_PATH); } catch {}
        fs.writeFileSync(LOG_PATH, ""); // truncate
      }
    } catch {
      // File doesn't exist yet — will be created by appendFileSync
    }

    fs.appendFileSync(LOG_PATH, content);
  } catch {
    // Never crash the plugin for debug logging failures
  }
}

/**
 * Resets the debug log file. Useful at plugin startup.
 */
export function resetDebugLog(): void {
  try {
    fs.writeFileSync(LOG_PATH, `=== Memory Wiki Engine debug log started at ${new Date().toISOString()} ===\n`);
  } catch {}
}
