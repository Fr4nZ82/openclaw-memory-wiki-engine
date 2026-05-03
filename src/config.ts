/**
 * config.ts — Plugin configuration schema
 *
 * All configurable paths and parameters. Sensible defaults
 * for standard installations (~/.openclaw/wiki-engine/).
 */

import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PluginConfig {
  /** Path to the main SQLite database */
  dbPath: string;

  /** Root directory for the auto-generated wiki */
  wikiPath: string;

  /** Drop zone for material to ingest (PDF, images, MD) */
  rawPath: string;

  /** Ollama server URL for embeddings */
  embeddingUrl: string;

  /** Ollama model for embeddings (must be 768 dims) */
  embeddingModel: string;

  /** Embedding vector dimensions */
  embeddingDimensions: number;

  /** Interval between light dreams (hours) */
  dreamIntervalHours: number;

  /** Nightly REM dream time (HH:MM format) */
  dreamRemTime: string;

  /** Conversation turns to keep in custom compaction */
  keepTurns: number;

  /** Max token budget for context injection into prompt */
  recallBudgetTokens: number;

  /** Recent messages the classifier sees (sliding window) */
  classifierWindowSize: number;

  /** Number of facts to return in hybrid search */
  recallTopK: number;

  /** Auto-dream trigger if pending captures exceed this threshold */
  dreamCaptureThreshold: number;

  /** Vector component weight in hybrid search (0-1) */
  vectorWeight: number;

  /** BM25 component weight in hybrid search (0-1) */
  bm25Weight: number;

  /** Enable debug logging across the engine */
  debug: boolean;

  /** Optional path to a JSON file with declarative system prompt patches */
  promptPatchesFile?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const OPENCLAW_HOME = process.env.OPENCLAW_HOME
  || path.join(os.homedir(), ".openclaw");

const ENGINE_HOME = path.join(OPENCLAW_HOME, "wiki-engine");

/**
 * Default configuration.
 * Each value can be overridden by the plugin config in openclaw.json.
 */
export const DEFAULT_CONFIG: PluginConfig = {
  dbPath: path.join(ENGINE_HOME, "engine.db"),
  wikiPath: path.join(ENGINE_HOME, "wiki"),
  rawPath: path.join(ENGINE_HOME, "raw"),

  // Ollama server for embeddings (configure for your network)
  embeddingUrl: "http://localhost:11434",
  embeddingModel: "nomic-embed-text",
  embeddingDimensions: 768,

  // Dream scheduling
  dreamIntervalHours: 6,
  dreamRemTime: "03:00",

  // Compaction
  keepTurns: 4,

  // Recall
  recallBudgetTokens: 4000,
  classifierWindowSize: 4,
  recallTopK: 10,
  dreamCaptureThreshold: 15, // Trigger auto-dream se i captures non processati superano questo limite

  // Hybrid search weights
  vectorWeight: 0.7,
  bm25Weight: 0.3,

  // Debugging
  debug: true,
};

// ---------------------------------------------------------------------------
// Merge with user config
// ---------------------------------------------------------------------------

/**
 * Takes the user config (partial, from openclaw.json) and merges it
 * with defaults. Explicit user values always win.
 */
export function resolveConfig(
  userConfig: Partial<PluginConfig> = {}
): PluginConfig {
  return { ...DEFAULT_CONFIG, ...userConfig };
}
