/**
 * classifier.ts — Message classifier
 *
 * The heart of the capture system. Every message passes through here to
 * decide:
 *   - What it's about (topics)
 *   - Whether it's a task/appointment (is_task → skills handle it)
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
import { jsonToTopics } from "./db";

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
   IMPORTANT: resolve relative dates using the message timestamp.
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

    // 4. Build the prompt
    const prompt = buildClassifierPrompt(
      windowMessages,
      message,
      currentTopic,
      userGroups,
      knownUsers,
      message.timestamp
    );

    // 5. Call the LLM via llm-task
    const response = await callLlmTask(api, prompt);

    // 6. Parse the response
    return parseClassification(response, message.sender_id);
  } catch (error) {
    // Safe fallback: don't memorize on error
    const log = api.getLogger?.("memory-wiki-engine") ?? console;
    log.warn("[Classifier] Classification error, falling back to non-memorable:", error);
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
// LLM
// ---------------------------------------------------------------------------

/**
 * Calls OpenClaw's llm-task for classification.
 *
 * llm-task is a built-in OpenClaw tool that allows structured
 * LLM calls (JSON) without spawning a subagent.
 */
async function callLlmTask(api: any, prompt: string): Promise<string> {
  // OpenClaw provides api.llmTask() for structured LLM calls
  if (api.llmTask) {
    const result = await api.llmTask({
      prompt,
      model: "flash",
      responseFormat: "json",
    });
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  // Fallback: use api.callTool if llmTask is not available
  if (api.callTool) {
    const result = await api.callTool("llm-task", {
      prompt,
      model: "flash",
    });
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  throw new Error("No method available to call the LLM");
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
