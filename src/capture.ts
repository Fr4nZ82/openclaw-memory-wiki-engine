/**
 * capture.ts — Message capture pipeline
 *
 * Handles two hooks:
 *
 *   1. `message_received` — when a user sends a message
 *      → save to archive + classify + save captures
 *
 *   2. `message_sending` — when the assistant responds
 *      → save to archive (for future context)
 *
 * The flow for a user message:
 *
 *   Message → Archive → Classifier → (is_task? skip) → Captures
 *
 * Captures remain in "session_captures" until the light dream
 * promotes them to permanent facts in the "facts" table.
 */

import type Database from "better-sqlite3";
import type { PluginConfig } from "./config";
import {
  classifyMessage,
  type ClassificationResult,
} from "./classifier";
import { topicsToJson } from "./utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Incoming message from OpenClaw hook */
export interface IncomingMessage {
  /** Message text */
  text: string;

  /** Sender ID (e.g. "7776007798" for Telegram) */
  sender_id: string;

  /** Human-readable sender name (e.g. "Alice") */
  sender_name: string;

  /** OpenClaw session ID (e.g. "agent:main:telegram:direct:7776007798") */
  session_id: string;

  /** Role: "user" or "assistant" */
  role: "user" | "assistant";

  /** ISO 8601 timestamp */
  timestamp: string;
}

/** Capture statistics (for logging) */
export interface CaptureStats {
  archived: boolean;
  classified: boolean;
  captured: boolean;
  skipped_reason: string | null;
  classification: ClassificationResult | null;
}

// ---------------------------------------------------------------------------
// Prepared SQL statements (lazy init)
// ---------------------------------------------------------------------------

interface PreparedStatements {
  insertArchive: Database.Statement;
  insertCapture: Database.Statement;
}

let stmts: PreparedStatements | null = null;

/**
 * Prepares SQL statements once (lazy).
 * Improves performance by avoiding SQL parse on every call.
 */
function getStatements(db: Database.Database): PreparedStatements {
  if (!stmts) {
    stmts = {
      insertArchive: db.prepare(`
        INSERT INTO session_archive
          (session_id, sender_id, sender_name, message_text, role, timestamp, topics)
        VALUES
          (@session_id, @sender_id, @sender_name, @message_text, @role, @timestamp, @topics)
      `),
      insertCapture: db.prepare(`
        INSERT INTO session_captures
          (session_id, message_text, fact_text, topics, sender_id,
           owner_type, owner_id, fact_type, is_internal, captured_at)
        VALUES
          (@session_id, @message_text, @fact_text, @topics, @sender_id,
           @owner_type, @owner_id, @fact_type, @is_internal, @captured_at)
      `),
    };
  }
  return stmts;
}

// ---------------------------------------------------------------------------
// Capture pipeline
// ---------------------------------------------------------------------------

/**
 * Processes a user message:
 *   1. Save to archive (always, for every message)
 *   2. Classify with the LLM
 *   3. If memorable and not a task → save to captures
 *
 * Returns statistics for logging.
 */
export async function processUserMessage(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  message: IncomingMessage
): Promise<CaptureStats> {
  const stats: CaptureStats = {
    archived: false,
    classified: false,
    captured: false,
    skipped_reason: null,
    classification: null,
  };

  // Step 1 — Archive: ALWAYS save the raw message
  archiveMessage(db, message, null);
  stats.archived = true;

  // Filter messages too short to classify
  if (message.text.trim().length < 5) {
    stats.skipped_reason = "message too short";
    return stats;
  }

  // Step 2 — Classify the message
  const classification = await classifyMessage(
    api,
    db,
    config,
    {
      text: message.text,
      sender_id: message.sender_id,
      sender_name: message.sender_name,
      timestamp: message.timestamp,
    },
    message.session_id
  );
  stats.classified = true;
  stats.classification = classification;

  // Step 3 — Evaluate whether to capture

  // 3a. Tasks and appointments → skills handle these, we skip
  if (classification.is_task && !classification.is_memorable) {
    stats.skipped_reason = "is_task (handled by skills)";
    return stats;
  }

  // 3b. Not memorable → skip
  if (!classification.is_memorable) {
    stats.skipped_reason = "not memorable";
    return stats;
  }

  // 3c. Empty fact_text → skip (classifier didn't extract anything)
  if (!classification.fact_text) {
    stats.skipped_reason = "empty fact_text";
    return stats;
  }

  // Step 4 — Save to captures
  saveCapture(db, message, classification);
  stats.captured = true;

  return stats;
}

/**
 * Processes an assistant message (response):
 *   - Saves to archive for future context
 *   - Does not classify (assistant doesn't generate facts to memorize)
 */
export function processAssistantMessage(
  db: Database.Database,
  message: IncomingMessage,
  topics: string[] | null
): void {
  archiveMessage(db, message, topics);
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

/**
 * Saves a message to the session archive.
 * The archive contains EVERYTHING — it's the complete transcript backup.
 */
function archiveMessage(
  db: Database.Database,
  message: IncomingMessage,
  topics: string[] | null
): void {
  const { insertArchive } = getStatements(db);

  insertArchive.run({
    session_id: message.session_id,
    sender_id: message.sender_id,
    sender_name: message.sender_name,
    message_text: message.text,
    role: message.role,
    timestamp: message.timestamp,
    topics: topics ? topicsToJson(topics) : null,
  });
}

/**
 * Saves a capture to session_captures.
 * Captures stay here until the light dream promotes them.
 */
function saveCapture(
  db: Database.Database,
  message: IncomingMessage,
  classification: ClassificationResult
): void {
  const { insertCapture } = getStatements(db);

  insertCapture.run({
    session_id: message.session_id,
    message_text: message.text,
    fact_text: classification.fact_text,
    topics: topicsToJson(classification.topics),
    sender_id: message.sender_id,
    owner_type: classification.owner_type,
    owner_id: classification.owner_id,
    fact_type: classification.fact_type,
    is_internal: classification.is_internal ? 1 : 0,
    captured_at: message.timestamp,
  });
}

// ---------------------------------------------------------------------------
// Reset (for tests or session change)
// ---------------------------------------------------------------------------

/**
 * Resets prepared statements.
 * Needed if the database is closed and reopened.
 */
export function resetStatements(): void {
  stmts = null;
}
