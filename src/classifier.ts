import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { dbg } from "./debug";

const log = dbg("classifier");

/**
 * classifier.ts — Message classifier
 *
 * The heart of the capture system. Every message passes through here to
 * decide:
 *   - What it's about (topics)
 *   - Whether it's a task/appointment (is_task → skills handle it)
 *   - Whether it's a technical message (is_internal)
 *   - Whether it's worth remembering (is_memorable)
 *   - What exactly to remember (fact_text)
 *   - Who the fact belongs to (owner attribution)
 *   - What type it is (fact, preference, rule, episode)
 *
 * Uses OpenClaw's `llm-task` with Gemini Flash — fast and cheap.
 * Receives a sliding window of the last N messages for context.
 */

import type Database from "better-sqlite3";
import type { PluginConfig } from "./config";
import { jsonToTopics } from "./utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The classification result for a single message */
export interface ClassificationResult {
  /** Array of topics (1-2 words each, lowercase) */
  topics: string[];

  /** true → it's a task, appointment, or errand. Skills handle these */
  is_task: boolean;

  /** true → it's a technical message about the system itself */
  is_internal: boolean;

  /** true → contains information worth remembering */
  is_memorable: boolean;

  /** The extracted fact (with relative dates resolved). Empty if !is_memorable */
  fact_text: string;

  /** Fact type */
  fact_type: "fact" | "preference" | "rule" | "episode";

  /** Who the fact belongs to: individual user, group, or global */
  owner_type: "user" | "group" | "global";

  /** Owner ID. May differ from sender (cross-user attribution) */
  owner_id: string;
}

/** A message in the context sliding window */
export interface WindowMessage {
  sender_id: string;
  sender_name: string;
  text: string;
  role: "user" | "assistant";
}

/** Current user's group information */
export interface UserGroupInfo {
  group_id: string;
  group_name: string;
}

/** Known user identity (from users table) */
export interface UserIdentity {
  sender_id: string;
  canonical_name: string;  // first name in the array (lowercase for owner_id)
  all_names: string[];     // all names including aliases
}

// ---------------------------------------------------------------------------
// Classification prompt
// ---------------------------------------------------------------------------

/**
 * Builds the classifier prompt.
 *
 * The prompt is designed to be clear and structured, with concrete
 * examples for each output type. The user's group list is injected
 * to enable cross-user attribution.
 */
function buildClassifierPrompt(
  windowMessages: WindowMessage[],
  currentMessage: { text: string; sender_id: string; sender_name: string },
  currentSessionTopic: string | null,
  userGroups: UserGroupInfo[],
  knownUsers: UserIdentity[],
  messageTimestamp: string
): string {
  // Format the sliding window
  const windowText = windowMessages
    .map((m) => `[${m.role === "user" ? m.sender_name : "Assistant"}]: ${m.text}`)
    .join("\n");

  // Format the user's groups
  const groupsText =
    userGroups.length > 0
      ? userGroups.map((g) => `- ${g.group_id} (${g.group_name})`).join("\n")
      : "- no groups";

  // Format known users for cross-user attribution
  const currentUser = knownUsers.find((u) => u.sender_id === currentMessage.sender_id);
  const senderLabel = currentUser
    ? `${currentUser.canonical_name} (aliases: ${currentUser.all_names.slice(1).join(", ") || "none"})`
    : currentMessage.sender_name;

  const knownUsersText = knownUsers
    .map((u) => {
      const names = u.all_names.join(", ");
      return `- ${u.canonical_name} (ID: ${u.sender_id}) → known as: ${names}`;
    })
    .join("\n");

  return `You are a message classifier for a family AI assistant.
Your task is to analyze ONE message and decide if it contains information worth remembering.

## Conversation context (recent messages)
${windowText || "(no previous context)"}

## Current session topic
${currentSessionTopic || "none (session start)"}

## User's groups
${groupsText}

## Known users
${knownUsersText || "(no users enrolled)"}

## Message timestamp
${messageTimestamp}

## New message from ${senderLabel}
"${currentMessage.text}"

## Instructions

Analyze the message and respond with valid JSON:

{
  "topics": ["topic1", "topic2"],
  "is_task": false,
  "is_internal": false,
  "is_memorable": true,
  "fact_text": "the extracted fact with resolved dates",
  "fact_type": "preference",
  "owner_type": "user",
  "owner_id": "username"
}

### Rules

1. **topics**: array of 1-3 tags (1-2 lowercase words each).
   Examples: "cooking", "alice", "sports", "work", "rules"

2. **is_task**: true for action requests, appointments, errands, reminders.
   Examples: "remind me to...", "dentist is on Friday", "buy milk"
   Tasks are handled by skills, not by memory.

3. **is_internal**: true if the message is about the system itself, debug, config,
   technical errors, agents, pipeline, deployment.

4. **is_memorable**: true if the message contains a FACT worth remembering.
   Not memorable: greetings, thanks, pure questions, generic help requests.
   A message can be is_task=true AND is_memorable=true if it contains
   both an action and a fact (rare — when in doubt, choose is_task only).

5. **fact_text**: the extracted fact, rephrased in third person, clean.
   IMPORTANT: write the fact in the SAME LANGUAGE as the original message.
   If the message is in Italian, the fact_text must be in Italian.
   If the message is in English, the fact_text must be in English.
   Resolve relative dates using the message timestamp.
   "tomorrow" → concrete date. "last Saturday" → concrete date.
   "last week" → concrete date.

6. **fact_type**:
   - "fact" — objective information (Alice does karate)
   - "preference" — taste, preference (doesn't like pesto)
   - "rule" — rule that changes the assistant's behavior (max 2h computer)
   - "episode" — temporary event (I'm reading a book)

7. **owner_type and owner_id**: who OWNS the fact (not who says it).
   owner_id must be the CANONICAL NAME (first name, lowercase) from the known users list.
   If ${senderLabel} says "Bob doesn't like pesto":
   → look up Bob in the known users list → use their canonical name as owner_id
   If they say "we need detergent" (family fact):
   → owner_type: "group", owner_id: "${userGroups[0]?.group_id || "family"}"
   If they say "I prefer coffee":
   → owner_type: "user", owner_id: "${currentUser?.canonical_name.toLowerCase() || currentMessage.sender_id}"

### Output

Respond ONLY with JSON, no markdown, no explanations.
If the message is not memorable, respond with is_memorable: false and empty fact_text.`;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classifies a message using the LLM (Gemini Flash via llm-task).
 *
 * @param api      - The OpenClaw API object (to call llm-task)
 * @param db       - The database (to read the sliding window from archive)
 * @param config   - Plugin configuration
 * @param message  - The message to classify
 * @param sessionId - Current session ID
 * @returns The classification result
 */
export async function classifyMessage(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  message: {
    text: string;
    sender_id: string;
    sender_name: string;
    timestamp: string;
  },
  sessionId: string
): Promise<ClassificationResult> {
  try {
    // 1. Retrieve the sliding window from archive
    const windowMessages = getRecentMessages(
      db,
      sessionId,
      config.classifierWindowSize
    );

    // 2. Get the current session topic (from latest capture)
    const currentTopic = getCurrentSessionTopic(db, sessionId);

    // 3. Get the user's groups
    const userGroups = getUserGroups(db, message.sender_id);

    // 3b. Get all known users (for cross-user attribution)
    const knownUsers = getAllUsers(db);

    log(`classifyMessage: sender=${message.sender_id}, name=${message.sender_name}, session=${sessionId}`);
    log(`classifyMessage: windowMessages=${windowMessages.length}, currentTopic=${currentTopic}, groups=${userGroups.length}`);
    log(`classifyMessage: knownUsers=${JSON.stringify(knownUsers.map(u => ({ id: u.sender_id, canonical: u.canonical_name })))}`);

    const currentUser = knownUsers.find((u) => u.sender_id === message.sender_id);
    log(`classifyMessage: currentUser match=${currentUser ? currentUser.canonical_name : 'NOT FOUND (sender_id mismatch!)'}`);

    // 4. Build the prompt
    const prompt = buildClassifierPrompt(
      windowMessages,
      message,
      currentTopic,
      userGroups,
      knownUsers,
      message.timestamp
    );

    log(`PROMPT (first 500 chars): ${prompt.substring(0, 500)}`);
    log(`PROMPT (last 300 chars): ${prompt.substring(prompt.length - 300)}`);

    // 5. Call the LLM
    log(`Calling Gemini Flash...`);
    const response = await callLlmTask(api, prompt);
    log(`FULL GEMINI RESPONSE:\n${response}`);

    // 6. Parse the response
    const result = parseClassification(response, message.sender_id);
    log(`PARSED: memorable=${result.is_memorable}, topics=${JSON.stringify(result.topics)}, owner=${result.owner_id}, fact_type=${result.fact_type}, fact_text="${result.fact_text}"`);
    return result;
  } catch (error) {
    // Safe fallback: don't memorize on error
    console.warn(`[Classifier] Classification error, falling back to non-memorable:`, error);
    log(`CLASSIFICATION FAILED: ${error}`);
    return createFallbackResult(message.sender_id);
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Retrieves the last N messages from the archive for this session.
 * Used as context for the classifier (sliding window).
 */
function getRecentMessages(
  db: Database.Database,
  sessionId: string,
  windowSize: number
): WindowMessage[] {
  const rows = db
    .prepare(
      `SELECT sender_id, sender_name, message_text, role
       FROM session_archive
       WHERE session_id = ?
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(sessionId, windowSize) as Array<{
    sender_id: string;
    sender_name: string | null;
    message_text: string;
    role: string;
  }>;

  // Return in chronological order (oldest to newest)
  return rows.reverse().map((r) => ({
    sender_id: r.sender_id,
    sender_name: r.sender_name ?? r.sender_id,
    text: r.message_text,
    role: r.role as "user" | "assistant",
  }));
}

/**
 * Gets the current session topic from the latest capture.
 */
function getCurrentSessionTopic(
  db: Database.Database,
  sessionId: string
): string | null {
  const row = db
    .prepare(
      `SELECT topics FROM session_captures
       WHERE session_id = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(sessionId) as { topics: string } | undefined;

  if (!row) return null;

  const topics = jsonToTopics(row.topics);
  return topics.length > 0 ? topics[0] : null;
}

/**
 * Gets the groups the user is a member of.
 */
function getUserGroups(
  db: Database.Database,
  senderId: string
): UserGroupInfo[] {
  return db
    .prepare(
      `SELECT g.id as group_id, g.name as group_name
       FROM user_groups g
       JOIN group_members m ON g.id = m.group_id
       WHERE m.sender_id = ?`
    )
    .all(senderId) as UserGroupInfo[];
}

/**
 * Gets all enrolled users with their names.
 * Used to populate the classifier prompt for cross-user attribution.
 */
function getAllUsers(db: Database.Database): UserIdentity[] {
  const rows = db
    .prepare(`SELECT sender_id, names FROM users`)
    .all() as Array<{ sender_id: string; names: string }>;

  return rows.map((row) => {
    let allNames: string[];
    try {
      allNames = JSON.parse(row.names) as string[];
    } catch {
      allNames = [row.sender_id];
    }
    return {
      sender_id: row.sender_id,
      canonical_name: allNames[0] || row.sender_id,
      all_names: allNames,
    };
  });
}

// ---------------------------------------------------------------------------
// Shared API audit (writes to same apiaudit.txt used by samvise-hooks)
// ---------------------------------------------------------------------------

const AUDIT_FILE = path.join(os.homedir(), ".openclaw", "apiaudit.txt");
const AUDIT_LOCK = AUDIT_FILE + ".lock";
const MAX_AUDIT_ENTRIES = 20;
const LOCK_RETRIES = 5;
const LOCK_WAIT_MS = 50;

/** Spins until the lock file can be exclusively created, or gives up. */
function acquireAuditLock(): boolean {
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      fs.writeFileSync(AUDIT_LOCK, String(process.pid), { flag: "wx" });
      return true;
    } catch (e: any) {
      if (e.code !== "EEXIST") return false;
      const start = Date.now();
      while (Date.now() - start < LOCK_WAIT_MS) {
        /* spin */
      }
    }
  }
  return false;
}

function releaseAuditLock(): void {
  try {
    fs.unlinkSync(AUDIT_LOCK);
  } catch {
    /* already removed */
  }
}

/**
 * Appends a classifier API call entry to the shared apiaudit.txt.
 * Same format as openclaw-samvise-hooks/audit.ts so all LLM calls
 * (gateway + direct) appear in one file.
 * Protected by a lock file to avoid corruption from concurrent writes.
 */
function writeClassifierAudit(prompt: string, model: string): void {
  if (!acquireAuditLock()) return; // skip silently — don't block the pipeline

  try {
    const entry = {
      timestamp: new Date().toISOString(),
      event: "classifier_direct_call",
      agentId: "memory-wiki-engine",
      provider: "google",
      model,
      imagesCount: 0,
      systemPrompt: prompt.substring(0, 500) + (prompt.length > 500 ? "..." : ""),
      messagesCount: 1,
      messages: [{ role: "user", content: prompt.substring(0, 200) + "..." }],
    };

    let history: unknown[] = [];
    if (fs.existsSync(AUDIT_FILE)) {
      try {
        history = JSON.parse(fs.readFileSync(AUDIT_FILE, "utf-8"));
        if (!Array.isArray(history)) history = [];
      } catch {
        history = [];
      }
    }

    history.push(entry);
    history = history.slice(-MAX_AUDIT_ENTRIES);
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(history, null, 2), "utf-8");
  } catch {
    // Never block the classifier pipeline for audit failures
  } finally {
    releaseAuditLock();
  }
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

/**
 * Calls Gemini Flash directly for classification.
 *
 * Resolves the API key from:
 *   1. api.runtime.modelAuth.getApiKeyForModel (preferred)
 *   2. GEMINI_API_KEY env variable (fallback)
 *   3. ~/.openclaw/.env file (last resort)
 *
 * Uses the REST API with JSON response mode for fast, structured output.
 */
async function callLlmTask(api: any, prompt: string): Promise<string> {
  const apiKey = await resolveGeminiApiKey(api);
  if (!apiKey) {
    throw new Error("No Gemini API key found (checked api.runtime.modelAuth, env, ~/.openclaw/.env)");
  }

  const model = "gemini-3-flash-preview";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1,
        maxOutputTokens: 16384,
      },
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gemini API error ${response.status}: ${text.substring(0, 200)}`);
  }

  const data = await response.json() as any;
  const finishReason = data?.candidates?.[0]?.finishReason;
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  log(`Gemini finishReason=${finishReason}, content length=${content?.length || 0}`);
  if (finishReason === "MAX_TOKENS") {
    log(`WARNING: Gemini hit MAX_TOKENS — response truncated!`);
  }
  if (!content) {
    log(`Gemini raw response: ${JSON.stringify(data).substring(0, 500)}`);
    throw new Error("Empty response from Gemini");
  }

  // Log to shared apiaudit.txt (same file as samvise-hooks audit)
  writeClassifierAudit(prompt, model);

  return content;
}

/**
 * Resolves the Gemini API key from available sources.
 *
 * The SDK may return either a plain string or an object { apiKey: "..." }.
 * We handle both cases and fall back to getApiKeyForModel if provider
 * resolution fails.
 */
async function resolveGeminiApiKey(api: any): Promise<string | null> {
  log(`resolveGeminiApiKey: modelAuth=${!!api.runtime?.modelAuth}, resolveForProvider=${!!api.runtime?.modelAuth?.resolveApiKeyForProvider}, getForModel=${!!api.runtime?.modelAuth?.getApiKeyForModel}`);

  // 1. Try resolveApiKeyForProvider (provider-level resolution)
  if (api.runtime?.modelAuth?.resolveApiKeyForProvider) {
    try {
      const result = await api.runtime.modelAuth.resolveApiKeyForProvider({
        provider: "google",
        cfg: api.config,
      });
      log(`resolveApiKeyForProvider returned: type=${typeof result}, keys=${result ? Object.keys(result) : 'null'}`);
      const key = typeof result === "string" ? result : result?.apiKey;
      log(`Extracted key: ${key ? key.substring(0, 8) + '...' + key.substring(key.length - 4) : 'NULL'}`);
      if (key && typeof key === "string") return key;
    } catch (e) {
      log(`resolveApiKeyForProvider THREW: ${e}`);
      console.warn("[Classifier] resolveApiKeyForProvider failed, trying fallback:", e);
    }
  }

  // 2. Fallback: getApiKeyForModel (model-level resolution)
  if (api.runtime?.modelAuth?.getApiKeyForModel) {
    try {
      const result = await api.runtime.modelAuth.getApiKeyForModel({
        model: "gemini-3-flash-preview",
        cfg: api.config,
      });
      log(`getApiKeyForModel returned: type=${typeof result}, keys=${result ? Object.keys(result) : 'null'}`);
      const key = typeof result === "string" ? result : result?.apiKey;
      log(`Fallback key: ${key ? key.substring(0, 8) + '...' + key.substring(key.length - 4) : 'NULL'}`);
      if (key && typeof key === "string") return key;
    } catch (e) {
      log(`getApiKeyForModel THREW: ${e}`);
      console.warn("[Classifier] getApiKeyForModel failed:", e);
    }
  }

  log(`ALL key resolution methods FAILED — returning null`);
  return null;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parses the LLM's JSON response into a ClassificationResult.
 * Resilient: handles malformed JSON, missing fields, wrong types.
 */
function parseClassification(
  raw: string,
  fallbackSenderId: string
): ClassificationResult {
  // Remove any markdown wrapper (```json ... ```)
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON from mixed text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        return createFallbackResult(fallbackSenderId);
      }
    } else {
      return createFallbackResult(fallbackSenderId);
    }
  }

  // Validate and normalize each field with safe fallbacks
  return {
    topics: normalizeTopics(parsed.topics),
    is_task: Boolean(parsed.is_task),
    is_internal: Boolean(parsed.is_internal),
    is_memorable: Boolean(parsed.is_memorable),
    fact_text: typeof parsed.fact_text === "string" ? parsed.fact_text.trim() : "",
    fact_type: validateFactType(parsed.fact_type),
    owner_type: validateOwnerType(parsed.owner_type),
    owner_id:
      typeof parsed.owner_id === "string" && parsed.owner_id.trim()
        ? parsed.owner_id.trim().toLowerCase()
        : fallbackSenderId,
  };
}

/**
 * Normalizes topics: accepts single string or array,
 * converts everything to lowercase, removes duplicates.
 */
function normalizeTopics(raw: any): string[] {
  if (!raw) return ["general"];

  const arr: string[] = Array.isArray(raw)
    ? raw.map(String)
    : [String(raw)];

  const unique = [...new Set(arr.map((t) => t.trim().toLowerCase()))];
  return unique.length > 0 ? unique : ["general"];
}

/**
 * Validates fact_type — only allowed values.
 */
function validateFactType(raw: any): ClassificationResult["fact_type"] {
  const valid = ["fact", "preference", "rule", "episode"] as const;
  return valid.includes(raw) ? raw : "fact";
}

/**
 * Validates owner_type — only allowed values.
 */
function validateOwnerType(raw: any): ClassificationResult["owner_type"] {
  const valid = ["user", "group", "global"] as const;
  return valid.includes(raw) ? raw : "user";
}

/**
 * Safe fallback result: don't memorize anything.
 * Used when the classifier fails or the JSON is malformed.
 */
function createFallbackResult(senderId: string): ClassificationResult {
  return {
    topics: ["general"],
    is_task: false,
    is_internal: false,
    is_memorable: false,
    fact_text: "",
    fact_type: "fact",
    owner_type: "user",
    owner_id: senderId,
  };
}
