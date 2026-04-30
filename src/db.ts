/**
 * db.ts — SQLite setup and database schema
 *
 * Uses better-sqlite3 for synchronous access (simpler and faster
 * than async drivers for a local DB).
 *
 * The database contains 5 areas:
 *   1. facts          — permanent facts with embeddings and FTS
 *   2. session_captures — classified buffer (not yet promoted)
 *   3. session_archive — raw complete transcripts
 *   4. user_groups     — user groups with dual scope
 *   5. schema_version  — incremental migration tracking
 *
 * On first startup, creates all tables. On subsequent startups,
 * checks schema version and applies migrations.
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import type { PluginConfig } from "./config";

// ---------------------------------------------------------------------------
// Exported types (mirror DB rows)
// ---------------------------------------------------------------------------

/** A permanent fact in the database */
export interface Fact {
  id: string;
  text: string;
  /** JSON array of topics — e.g. '["cooking","alice"]' */
  topics: string;
  sender_id: string;
  owner_type: "user" | "group" | "global";
  owner_id: string;
  fact_type: "fact" | "preference" | "rule" | "episode";
  /** Serialized vector embedding (Float32, 768 dims) */
  embedding: Buffer | null;
  confidence: number;
  access_count: number;
  created_at: string;
  updated_at: string;
  superseded_by: string | null;
  is_active: number;
}

/** A session capture (not yet promoted to fact) */
export interface SessionCapture {
  id: number;
  session_id: string;
  message_text: string;
  fact_text: string;
  topics: string;
  sender_id: string;
  owner_type: "user" | "group" | "global";
  owner_id: string;
  fact_type: "fact" | "preference" | "rule" | "episode";
  is_internal: number;
  captured_at: string;
  promoted: number; // 0=pending, 1=promoted, 2=discarded
}

/** A message in the session archive */
export interface ArchiveMessage {
  id: number;
  session_id: string;
  sender_id: string;
  sender_name: string | null;
  message_text: string;
  role: "user" | "assistant";
  timestamp: string;
  topics: string | null;
}

/** A user group */
export interface UserGroup {
  id: string;
  name: string;
  description: string | null;
}

/** A group member */
export interface GroupMember {
  group_id: string;
  sender_id: string;
  role: "member" | "admin";
}

// ---------------------------------------------------------------------------
// SQL schema — current version
// ---------------------------------------------------------------------------

const CURRENT_SCHEMA_VERSION = 1;

/**
 * Table creation SQL for schema v1.
 * Each statement is separate for readability and
 * easier debugging on error.
 */
const SCHEMA_V1: string[] = [
  // -----------------------------------------------------------------------
  // Schema version table (for future migrations)
  // -----------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS schema_version (
    version  INTEGER NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // -----------------------------------------------------------------------
  // Layer 2 — Facts DB
  // -----------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS facts (
    id             TEXT PRIMARY KEY,
    text           TEXT NOT NULL,
    topics         TEXT NOT NULL DEFAULT '[]',
    sender_id      TEXT NOT NULL,
    owner_type     TEXT NOT NULL DEFAULT 'user',
    owner_id       TEXT NOT NULL,
    fact_type      TEXT NOT NULL DEFAULT 'fact',
    embedding      BLOB,
    confidence     REAL NOT NULL DEFAULT 1.0,
    access_count   INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    superseded_by  TEXT,
    is_active      INTEGER NOT NULL DEFAULT 1
  )`,

  // Indexes for the most common queries
  `CREATE INDEX IF NOT EXISTS idx_facts_active
     ON facts (is_active) WHERE is_active = 1`,

  `CREATE INDEX IF NOT EXISTS idx_facts_owner
     ON facts (owner_type, owner_id) WHERE is_active = 1`,

  `CREATE INDEX IF NOT EXISTS idx_facts_type
     ON facts (fact_type) WHERE is_active = 1`,

  // FTS5 for text search (BM25)
  `CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    text,
    topics,
    content = 'facts',
    content_rowid = 'rowid',
    tokenize = 'unicode61'
  )`,

  // Triggers to keep FTS in sync with the facts table
  `CREATE TRIGGER IF NOT EXISTS facts_fts_insert
     AFTER INSERT ON facts BEGIN
       INSERT INTO facts_fts (rowid, text, topics)
         VALUES (new.rowid, new.text, new.topics);
     END`,

  `CREATE TRIGGER IF NOT EXISTS facts_fts_delete
     AFTER DELETE ON facts BEGIN
       INSERT INTO facts_fts (facts_fts, rowid, text, topics)
         VALUES ('delete', old.rowid, old.text, old.topics);
     END`,

  `CREATE TRIGGER IF NOT EXISTS facts_fts_update
     AFTER UPDATE ON facts BEGIN
       INSERT INTO facts_fts (facts_fts, rowid, text, topics)
         VALUES ('delete', old.rowid, old.text, old.topics);
       INSERT INTO facts_fts (rowid, text, topics)
         VALUES (new.rowid, new.text, new.topics);
     END`,

  // -----------------------------------------------------------------------
  // Layer 3 — Session Captures (persistent buffer)
  // -----------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS session_captures (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    message_text  TEXT NOT NULL,
    fact_text     TEXT NOT NULL,
    topics        TEXT NOT NULL DEFAULT '[]',
    sender_id     TEXT NOT NULL,
    owner_type    TEXT NOT NULL DEFAULT 'user',
    owner_id      TEXT NOT NULL,
    fact_type     TEXT NOT NULL DEFAULT 'fact',
    is_internal   INTEGER NOT NULL DEFAULT 0,
    captured_at   TEXT NOT NULL DEFAULT (datetime('now')),
    promoted      INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE INDEX IF NOT EXISTS idx_captures_pending
     ON session_captures (promoted) WHERE promoted = 0`,

  `CREATE INDEX IF NOT EXISTS idx_captures_session
     ON session_captures (session_id)`,

  // -----------------------------------------------------------------------
  // Layer 5 — Session Archive (raw transcripts)
  // -----------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS session_archive (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    sender_id     TEXT NOT NULL,
    sender_name   TEXT,
    message_text  TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
    topics        TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_archive_session
     ON session_archive (session_id)`,

  `CREATE INDEX IF NOT EXISTS idx_archive_timestamp
     ON session_archive (timestamp)`,

  // FTS5 for text search in the archive
  `CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(
    message_text,
    sender_name,
    topics,
    content = 'session_archive',
    content_rowid = 'rowid',
    tokenize = 'unicode61'
  )`,

  // FTS triggers for the archive
  `CREATE TRIGGER IF NOT EXISTS archive_fts_insert
     AFTER INSERT ON session_archive BEGIN
       INSERT INTO archive_fts (rowid, message_text, sender_name, topics)
         VALUES (new.rowid, new.message_text, new.sender_name, new.topics);
     END`,

  `CREATE TRIGGER IF NOT EXISTS archive_fts_delete
     AFTER DELETE ON session_archive BEGIN
       INSERT INTO archive_fts (archive_fts, rowid, message_text, sender_name, topics)
         VALUES ('delete', old.rowid, old.message_text, old.sender_name, old.topics);
     END`,

  // -----------------------------------------------------------------------
  // Users (identity map: sender_id → names)
  // -----------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS users (
    sender_id  TEXT PRIMARY KEY,
    names      TEXT NOT NULL     -- JSON array: ["Frodo","Francesco"]. First = canonical
  )`,

  // -----------------------------------------------------------------------
  // User groups
  // -----------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS user_groups (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    scope       TEXT          -- JSON array: describes what facts belong to this group
  )`,

  `CREATE TABLE IF NOT EXISTS group_members (
    group_id   TEXT NOT NULL,
    sender_id  TEXT NOT NULL,
    PRIMARY KEY (group_id, sender_id),
    FOREIGN KEY (group_id) REFERENCES user_groups(id),
    FOREIGN KEY (sender_id) REFERENCES users(sender_id)
  )`,
];

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Opens (or creates) the database and applies the schema.
 *
 * Also creates necessary directories if they don't exist:
 *   - DB directory
 *   - wiki/
 *   - raw/
 *
 * Returns the Database instance ready to use.
 */
export function initDatabase(config: PluginConfig): Database.Database {
  // Ensure directories exist
  const dbDir = path.dirname(config.dbPath);
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(config.wikiPath, { recursive: true });
  fs.mkdirSync(config.rawPath, { recursive: true });

  // Create wiki subdirectories (Topic-Driven)
  for (const sub of ["pages", ".shadow", "_meta"]) {
    fs.mkdirSync(path.join(config.wikiPath, sub), { recursive: true });
  }

  // Open the database
  const db = new Database(config.dbPath);

  // SQLite performance optimizations
  db.pragma("journal_mode = WAL");    // Write-Ahead Logging — non-blocking reads
  db.pragma("synchronous = NORMAL");  // Good durability/speed tradeoff
  db.pragma("foreign_keys = ON");     // Referential integrity

  // Check if schema needs to be applied
  applySchema(db);

  return db;
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

/**
 * Applies the schema if needed. Checks the current version
 * and applies missing migrations.
 */
function applySchema(db: Database.Database): void {
  // The schema_version table may not exist yet
  const hasVersionTable = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'schema_version'`
    )
    .get();

  let currentVersion = 0;

  if (hasVersionTable) {
    const row = db
      .prepare("SELECT MAX(version) as v FROM schema_version")
      .get() as { v: number | null } | undefined;
    currentVersion = row?.v ?? 0;
  }

  // Already at current version, nothing to do
  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return;
  }

  // Apply migrations in a transaction
  const migrate = db.transaction(() => {
    // v1: initial schema
    if (currentVersion < 1) {
      for (const sql of SCHEMA_V1) {
        db.exec(sql);
      }
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(1);
    }

    // v2, v3, etc. — future migrations go here
    // if (currentVersion < 2) { ... }
  });

  migrate();
}

// ---------------------------------------------------------------------------
// Utility helpers — re-exported from utils.ts for backward compatibility
// ---------------------------------------------------------------------------

/**
 * Closes the database cleanly.
 * Should be called in the plugin shutdown hook.
 */
export function closeDatabase(db: Database.Database): void {
  db.close();
}

export { generateFactId, topicsToJson, jsonToTopics } from "./utils";
