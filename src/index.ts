/**
 * index.ts — Plugin entry point
 *
 * Registers all hooks, tools, and commands for the Memory Wiki Engine.
 * This file is the "wiring" — actual logic lives in specialized modules.
 *
 * Modules:
 *   config.ts     → configuration with defaults
 *   db.ts         → SQLite schema and initialization
 *   classifier.ts → message classification with Gemini Flash
 *   capture.ts    → capture pipeline (archive + classify + save)
 *   recall.ts     → context injection into the prompt
 *   embedding.ts  → Ollama client for vector embeddings
 *   supersede.ts  → fact supersedence logic
 *   dream.ts      → memory consolidation (light + REM)
 *
 * Registered hooks:
 *   - message_received    → captures user messages
 *   - message_sending     → archives assistant responses
 *   - before_prompt_build → injects context into the prompt
 *
 * Registered tools:
 *   - memory_search  — hybrid search (BM25 + vector) on facts + wiki
 *   - remember       — explicitly save a fact
 *
 * Registered commands:
 *   - /dream          — trigger manual dream
 *   - /memory-status  — memory statistics
 *   - /focus <topic>  — force session topic
 */

import type Database from "better-sqlite3";
import { resolveConfig, type PluginConfig } from "./config";
import { topicsToJson } from "./utils";
import { dbg, resetDebugLog, setDebugEnabled } from "./debug";
// NOTE: db.ts is NOT imported at the top level to avoid eagerly loading
// the better-sqlite3 native addon. It's loaded dynamically inside getDb().
import {
  processUserMessage,
  processAssistantMessage,
  resetStatements,
  type IncomingMessage,
} from "./capture";
import { buildRecallContext, resolveCanonicalId } from "./recall";
import { dreamLight, dreamRem } from "./dream";
import {
  wikiIngest,
  wikiLint,
  wikiSync,
  searchArchive,
  getWikiStatus,
} from "./wiki-manager";

const dlog = dbg("hooks");

// ---------------------------------------------------------------------------
// Plugin state
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;
let config: PluginConfig | null = null;
let dreamTimer: ReturnType<typeof setInterval> | null = null;
let remTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Sender ID from the most recent before_prompt_build call.
 * Used by the `remember` tool to attribute facts to the correct user
 * (since tools don't have direct access to the conversation event).
 *
 * This is safe because OpenClaw processes one conversation turn at a time
 * per gateway instance — the sender resolved in before_prompt_build is
 * the same sender whose tool calls execute immediately after.
 */
let lastResolvedSender: string = "unknown";


// Lazily loaded db.ts module — avoids eager better-sqlite3 native addon load
let dbModule: typeof import("./db") | null = null;

/**
 * Lazy DB initializer. Opens the database on first access
 * instead of eagerly during register(). This avoids the cost of
 * loading better-sqlite3 + running DDL for every CLI command.
 */
function getDb(): Database.Database | null {
  if (db) return db;
  if (!config) return null;
  // Dynamic require — loads better-sqlite3 only when actually needed
  if (!dbModule) {
    dbModule = require("./db");
  }
  db = dbModule!.initDatabase(config);
  return db;
}

// ---------------------------------------------------------------------------
// OpenClaw entry point
// ---------------------------------------------------------------------------

/**
 * Main plugin register function. OpenClaw calls this during plugin initialization.
 *
 * `api` is the object provided by OpenClaw with methods to register
 * hooks, tools, commands, and compaction providers.
 */
function register(api: any): void {
  // OpenClaw calls register() in multiple modes — only do full init in "full" mode
  const registrationMode = api.registrationMode;
  if (registrationMode && registrationMode !== "full") return;

  // Read plugin config (from openclaw.json) and merge with defaults
  const userConfig = api.pluginConfig ?? api.getPluginConfig?.() ?? {};
  config = resolveConfig(userConfig);

  // Debug toggle: plugin config takes precedence over MWE_DEBUG env var
  if (typeof userConfig.debug === "boolean") {
    setDebugEnabled(userConfig.debug);
  }

  // NOTE: Database is NOT opened here — it's lazy-initialized on first access
  // via getDb(). This avoids the cost of loading better-sqlite3 + running DDL
  // for lightweight CLI commands (hooks list, status, help, etc.).

  // Startup log
  const ocLog = api.getLogger?.("memory-wiki-engine") ?? console;
  resetDebugLog();
  dlog(`Plugin register() called. mode=${registrationMode}, config resolved.`);

  // -------------------------------------------------------------------
  // Hook: message_received — capture user messages
  // -------------------------------------------------------------------

  if (api.on) {
    api.on("message_received", async (event: any) => {
      const database = getDb();
      if (!database || !config) {
        dlog(`Hook message_received SKIPPED: db=${!!database}, config=${!!config}`);
        return;
      }

      try {
        dlog(`event keys: ${Object.keys(event).join(', ')}`);
        dlog(`event.from=${event.from}, metadata=${JSON.stringify(event.metadata || {})}`);

        // SDK hook event shape (from Hooks docs):
        //   from, content, timestamp, metadata { senderId, senderName, channelId, guildId }
        const senderId = event.metadata?.senderId || event.from || "unknown";
        const senderName = event.metadata?.senderName || event.from || "unknown";
        // Session key: prefer channelId, fall back to "from" field (e.g. "telegram:7776007798")
        const sessionKey = event.metadata?.sessionKey || event.metadata?.channelId || event.from || "unknown";

        dlog(`Resolved sender: id=${senderId}, name=${senderName}, session=${sessionKey}`);

        const messageText = event.content || event.text || "";

        // Skip audio/media placeholders — transcription arrives later via before_prompt_build
        const mediaPlaceholders = ["<media:audio>", "[Audio]", "<media:video>"];
        if (mediaPlaceholders.some(p => messageText.trim().startsWith(p))) {
          dlog(`SKIPPED media placeholder: "${messageText.trim().substring(0, 30)}"`);
          return;
        }
        const message: IncomingMessage = {
          text: messageText,
          sender_id: senderId,
          sender_name: senderName,
          session_id: sessionKey,
          role: "user",
          timestamp: new Date().toISOString(),
        };

        // Skip empty messages
        if (!message.text.trim()) return;

        // Skip slash commands — handled by the command system, not worth classifying
        if (message.text.trim().startsWith("/")) {
          dlog(`SKIPPED slash command: "${message.text.trim().substring(0, 30)}"`);
          return;
        }

        dlog(`processUserMessage START: "${message.text.substring(0, 60)}" sender=${message.sender_id}`);

        // Check Pending Captures Threshold & Kill-Switch
        const pendingRows = database.prepare("SELECT COUNT(*) as count FROM session_captures WHERE promoted = 0").get() as { count: number };
        const pendingCount = pendingRows?.count || 0;

        if (pendingCount >= config.dreamCaptureThreshold * 2) {
          const { isOllamaAvailable } = await import("./embedding");
          const ollamaOnline = await isOllamaAvailable(config);
          
          if (!ollamaOnline) {
            ocLog.warn(`[Capture] 🛑 KILL-SWITCH ACTIVATED: Memory overflow (${pendingCount} pending) and Ollama is OFFLINE. Capture blocked.`);
            // Inform the user if possible via generic text response using the SDK, though not guaranteed to halt Samwise's reasoning hook
            try {
              if (api.sendMessage) {
                await api.sendMessage(event.from, "⚠️ [Memory Engine] Il mio sistema di memoria è in overflow e la torre GPU è irraggiungibile per la compressione. Non memorizzerò più nuovi fatti finché il problema non sarà risolto.");
              }
            } catch (err) {}
            return; // Abort capture pipeline completely
          }
        }

        const stats = await processUserMessage(api, database, config, message);

        dlog(`processUserMessage END: captured=${stats.captured}, classified=${stats.classified}, skipped=${stats.skipped_reason || 'none'}`);

        // Dynamic Dream Trigger
        if (pendingCount + (stats.captured ? 1 : 0) >= config.dreamCaptureThreshold) {
          ocLog.info(`[Capture] Threshold reached (${pendingCount + (stats.captured ? 1 : 0)} pending >= ${config.dreamCaptureThreshold}). Triggering automatic Dream Light...`);
          try {
            const { dreamLight } = await import("./dream");
            // Run async without awaiting so we don't block the hook
            dreamLight(database, config, ocLog).catch(e => {
              ocLog.error(`[Capture] Automatic Dream Light failed: ${e}`);
            });
          } catch (e) {
            ocLog.error(`[Capture] Failed to import dreamLight: ${e}`);
          }
        }

        if (stats.captured) {
          ocLog.info(
            `[Capture] ✅ "${message.text.substring(0, 40)}..." → ` +
              `topics: [${stats.classification?.topics.join(", ")}], ` +
              `type: ${stats.classification?.fact_type}, ` +
              `owner: ${stats.classification?.owner_id}`
          );
        } else if (stats.skipped_reason) {
          dlog(`[Capture] ⏭ "${message.text.substring(0, 30)}..." — ${stats.skipped_reason}`);
        }
      } catch (error) {
        ocLog.warn("[Capture] Error processing message:", error);
        dlog(`[Capture] UNHANDLED ERROR: ${error}`);
      }
    });

    // -------------------------------------------------------------------
    // Hook: message_sending — archive assistant responses
    // -------------------------------------------------------------------

    api.on("message_sending", (event: any) => {
      const database = getDb();
      if (!database) return;

      try {
        const text = event.content || event.text || "";
        const sessionKey = event.metadata?.sessionKey || event.metadata?.channelId || "unknown";

        const message: IncomingMessage = {
          text,
          sender_id: "assistant",
          sender_name: "Assistant",
          session_id: sessionKey,
          role: "assistant",
          timestamp: new Date().toISOString(),
        };

        if (!message.text.trim()) return;

        dlog(`message_sending archived: "${text.substring(0, 50)}..." session=${sessionKey}`);
        processAssistantMessage(database, message, null);
      } catch (error) {
        ocLog.warn("[Archive] Error archiving response:", error);
        dlog(`[Archive] UNHANDLED ERROR: ${error}`);
      }
    });

    // -------------------------------------------------------------------
    // Hook: before_prompt_build — context injection
    // -------------------------------------------------------------------

    api.on("before_prompt_build", async (event: any) => {
      const database = getDb();
      if (!database || !config) {
        dlog(`before_prompt_build SKIPPED: db=${!!database}, config=${!!config}`);
        return;
      }

      try {
        dlog(`before_prompt_build: event keys=${Object.keys(event).join(', ')}`);

        // ---------------------------------------------------------------
        // Extract the last REAL user message from event.messages.
        //
        // OpenClaw wraps user messages in a "Conversation info" envelope:
        //
        //   Conversation info (untrusted metadata):
        //   ```json
        //   { "chat_id": "telegram:7776007798", ... }
        //   ```
        //
        //   [actual user message text here]
        //
        // Other messages with role="user" are system-injected:
        //   - "## Operational rules" / "# MEMORY.md" — plugin prepend context
        //   - "A new session was started via /new or /reset" — session reset
        //
        // We must:
        //   1. Find the last "Conversation info" message (= real user msg)
        //   2. Parse out the user text (after the closing ```)
        //   3. Extract sender_id from the JSON metadata block
        // ---------------------------------------------------------------
        const messages: any[] = event.messages || [];

        // ---- Envelope helpers ----

        /** Check if a text part is an OpenClaw metadata envelope */
        function isEnvelopePart(text: string): boolean {
          return text.includes("(untrusted metadata):") && text.includes("```json");
        }

        /** Check if a text part is system-injected (not user text) */
        function isSystemContent(text: string): boolean {
          return (
            text.startsWith("## Operational rules") ||
            text.startsWith("# MEMORY.MD") ||
            text.startsWith("# MEMORY.md") ||
            text.startsWith("## Memory context") ||
            text.startsWith("## Routing hints") ||
            text.startsWith("A new session was started")
          );
        }

        /** Extract sender ID from an envelope's JSON block */
        function extractSenderFromEnvelope(raw: string): string {
          const chatIdMatch = raw.match(/"chat_id"\s*:\s*"(?:telegram:|discord:)(\d+)"/);
          if (chatIdMatch) return chatIdMatch[1];
          const senderMatch = raw.match(/"sender_id"\s*:\s*"(\d+)"/);
          if (senderMatch) return senderMatch[1];
          const userIdMatch = raw.match(/"user_id"\s*:\s*"(\d+)"/);
          if (userIdMatch) return userIdMatch[1];
          return "";
        }

        /** Parse an envelope part: extract user text after closing ``` and sender ID */
        function parseEnvelopeText(raw: string): { userText: string; senderId: string } {
          const senderId = extractSenderFromEnvelope(raw);
          const jsonStart = raw.indexOf("```json");
          if (jsonStart === -1) return { userText: "", senderId };

          // Trova il PRIMO ``` di chiusura dopo il blocco json
          const closingFence = raw.indexOf("```", jsonStart + 7);
          if (closingFence === -1 || closingFence <= jsonStart) {
            // Only one ``` found (the opening) — no closing fence
            dlog(`    parseEnvelopeText: no closing fence found (closingFence=${closingFence}, jsonStart=${jsonStart})`);
            return { userText: "", senderId };
          }

          // Everything after the closing ``` is the user text
          const afterFence = raw.substring(closingFence + 3).trim();

          // Debug: show the region around the closing fence
          const fenceContext = raw.substring(Math.max(0, closingFence - 20), Math.min(raw.length, closingFence + 20))
            .replace(/\n/g, "\\n").replace(/\r/g, "\\r");
          dlog(`    parseEnvelopeText: closingFence=${closingFence}, afterFence="${afterFence.substring(0, 80)}...", context="${fenceContext}"`);

          return { userText: afterFence, senderId };
        }

        // ---- Main extraction loop ----

        let userQuery = "";
        let extractedSenderId = "";
        let foundMsgIdx = -1;

        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.role !== "user") continue;

          // ---- Diagnostic dump for the last 3 user messages ----
          if (foundMsgIdx === -1) { // only dump while searching
            const contentType = typeof msg.content === "string" ? "string"
              : Array.isArray(msg.content) ? `array[${msg.content.length}]`
              : typeof msg.content;
            if (Array.isArray(msg.content)) {
              dlog(`  msg[${i}] role=user contentType=${contentType}:`);
              for (let p = 0; p < msg.content.length; p++) {
                const part = msg.content[p];
                const partText = part.type === "text" ? part.text : `[${part.type}]`;
                const preview = (typeof partText === "string" ? partText : String(partText))
                  .substring(0, 100).replace(/\n/g, "\\n");
                dlog(`    part[${p}] type=${part.type}: "${preview}..."`);
              }
            } else {
              const preview = String(msg.content ?? "").substring(0, 100).replace(/\n/g, "\\n");
              dlog(`  msg[${i}] role=user contentType=${contentType}: "${preview}..."`);
            }
          }

          // ---- Process content parts ----
          //
          // OpenClaw sends user messages as multi-part content arrays:
          //   part[0]: "Conversation info (untrusted metadata): ```json {...} ```"
          //   part[1]: "Sender (untrusted metadata): ```json {...} ```"
          //   part[2]: "ciao"  <-- the REAL user text
          //
          // We must process each part independently, not join them.

          if (Array.isArray(msg.content)) {
            const textParts: string[] = [];
            let partSenderId = "";

            for (const part of msg.content) {
              if (part.type !== "text" || !part.text) continue;
              const text = part.text.trim();

              if (isEnvelopePart(text)) {
                // Extract sender from envelope metadata
                const parsed = parseEnvelopeText(text);
                if (parsed.senderId && !partSenderId) partSenderId = parsed.senderId;
                // If the envelope has trailing text after the fence, include it
                if (parsed.userText && !isEnvelopePart(parsed.userText) && !isSystemContent(parsed.userText)) {
                  textParts.push(parsed.userText);
                }
              } else if (isSystemContent(text)) {
                // Skip system-injected content
                continue;
              } else if (text.length > 0) {
                // This is a real user text part
                textParts.push(text);
              }
            }

            const combinedText = textParts.join(" ").trim();
            if (combinedText) {
              userQuery = combinedText;
              extractedSenderId = partSenderId;
              foundMsgIdx = i;
              dlog(`  FOUND real user message in msg[${i}] (multi-part): "${userQuery.substring(0, 60)}..." sender=${extractedSenderId}`);
              break;
            } else if (partSenderId) {
              // Envelope found but no user text — skip (metadata-only message)
              dlog(`  msg[${i}]: envelope with sender=${partSenderId} but no user text — skipping`);
              continue;
            }
          }

          // ---- String content fallback ----
          if (typeof msg.content === "string") {
            const trimmed = msg.content.trim();

            if (isEnvelopePart(trimmed)) {
              const parsed = parseEnvelopeText(trimmed);
              if (parsed.userText && !isEnvelopePart(parsed.userText) && !isSystemContent(parsed.userText)) {
                userQuery = parsed.userText;
                extractedSenderId = parsed.senderId;
                foundMsgIdx = i;
                dlog(`  FOUND real user message in msg[${i}] (string+envelope): "${userQuery.substring(0, 60)}..." sender=${extractedSenderId}`);
                break;
              } else {
                dlog(`  msg[${i}]: string envelope but no user text — skipping`);
                continue;
              }
            }

            if (isSystemContent(trimmed)) {
              dlog(`  SKIPPING msg[${i}]: system-injected content`);
              continue;
            }

            // Plain user message
            userQuery = trimmed;
            foundMsgIdx = i;
            dlog(`  FOUND plain user message in msg[${i}]: "${userQuery.substring(0, 60)}..."`);
            break;
          }
        }

        if (!userQuery) {
          dlog(`before_prompt_build: SKIPPED recall — no real user message in turn (heartbeat/cron/system)`);
          return;
        }

        // Resolve sender identity.
        // Priority: extracted from Conversation info > message metadata > event metadata > sessionKey parse
        let senderId = extractedSenderId
          || messages[foundMsgIdx]?.metadata?.senderId
          || messages[foundMsgIdx]?.from
          || event.metadata?.senderId
          || "";

        const sessionId = event.sessionKey
          || event.metadata?.sessionKey
          || event.metadata?.channelId
          || (extractedSenderId ? `telegram:${extractedSenderId}` : "unknown");

        if (!senderId && sessionId !== "unknown") {
          const parts = sessionId.split(":");
          const lastPart = parts[parts.length - 1];
          if (lastPart && /^\d+$/.test(lastPart)) {
            senderId = lastPart;
            dlog(`before_prompt_build: sender extracted from sessionKey: ${senderId}`);
          }
        }
        if (!senderId) senderId = "unknown";

        // Save for the remember tool (BUG-10 fix)
        lastResolvedSender = senderId;

        dlog(`before_prompt_build: query="${userQuery.substring(0, 50)}", sender=${senderId}, session=${sessionId}`);

        // Fallback capture per trascrizioni vocali saltate da message_received
        if (userQuery.includes("[MIC] IN") || userQuery.includes("[Audio]")) {
          dlog(`before_prompt_build: detected voice transcription, running fallback capture`);
          let senderName = messages[foundMsgIdx]?.metadata?.senderName || event.metadata?.senderName || "unknown";
          processUserMessage(api, database, config, {
            text: userQuery,
            sender_id: senderId,
            sender_name: senderName,
            session_id: sessionId,
            role: "user",
            timestamp: new Date().toISOString(),
          }).then(stats => {
            if (stats.captured) {
              ocLog.info(`[Capture Fallback] ✅ Voice transcription captured`);
            }
          }).catch(err => {
            dlog(`[Capture Fallback] ERROR: ${err}`);
          });
        }

        const recallCtx = await buildRecallContext(
          api,
          database,
          config,
          sessionId,
          userQuery,
          senderId
        );

        // Return context for OpenClaw to inject (standard SDK pattern — ADR-013)
        dlog(`[Recall] ${recallCtx.estimatedTokens} tokens injected — wiki: ${recallCtx.details.wikiPagesMatched}, facts: ${recallCtx.details.factsMatched}, captures: ${recallCtx.details.capturesFound}, vector: ${recallCtx.details.vectorSearchUsed}`);
        return { prependContext: recallCtx.systemContext };
      } catch (error) {
        ocLog.warn("[Recall] Error injecting context:", error);
        dlog(`[Recall] UNHANDLED ERROR: ${error}`);
        // Don't block the response if recall fails
      }
    });
  }

  // -------------------------------------------------------------------
  // Context Engine (dual-kind: memory + context-engine)
  // Owns compaction — local truncation, no LLM summarization.
  // -------------------------------------------------------------------

  if (typeof api.registerContextEngine === "function") {
    api.registerContextEngine("openclaw-memory-wiki-engine", () => ({
      info: {
        id: "openclaw-memory-wiki-engine",
        name: "openclaw-memory-wiki-engine",
        ownsCompaction: true,
      },

      // No-op: message capture is handled by message_received / llm_output hooks
      async ingest() {
        return { ingested: true };
      },

      // Pass-through: recall context is injected by before_prompt_build hook
      async assemble({ messages }: { messages: any[] }) {
        return { messages, estimatedTokens: 0 };
      },

      // Local truncation: keep last keepTurns turns, drop older ones
      async compact({ messages }: { messages?: any[] }) {
        const keepTurns = config!.keepTurns;
        const keepMessages = keepTurns * 2;
        if (Array.isArray(messages) && messages.length > keepMessages) {
          dlog(`compact(): truncating ${messages.length} → ${keepMessages} messages (keepTurns=${keepTurns})`);
          return { messages: messages.slice(-keepMessages), compacted: true };
        }
        dlog(`compact(): no truncation needed (${messages?.length ?? 0} messages, keepTurns=${keepTurns})`);
        return { messages: messages ?? [], compacted: false };
      },
    }));
    ocLog.info("[Memory Wiki Engine] Context engine registered (ownsCompaction: true)");
  }

  // -------------------------------------------------------------------
  // Tool: memory_search
  // -------------------------------------------------------------------

  if (api.registerTool) {
    api.registerTool({
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search the memory. Hybrid search (semantic + keyword) " +
        "on facts, wiki and session captures. Use this tool when you " +
        "need to recall something about a user, a past event, " +
        "or a preference.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for in memory",
          },
        },
        required: ["query"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const database = getDb();
        if (!database || !config) return { content: [{ type: "text", text: "Memory not initialized" }] };

        const query = params.query as string;
        // Use sender from before_prompt_build (same pattern as remember tool)
        const senderId = lastResolvedSender !== "unknown" ? lastResolvedSender : "unknown";
        const sessionId = senderId !== "unknown" ? `telegram:${senderId}` : "unknown";
        const recallCtx = await buildRecallContext(
          api,
          database,
          config,
          sessionId,
          query,
          senderId
        );

        return { content: [{ type: "text", text: recallCtx.systemContext || "No results found." }] };
      },
    });

    // NOTE: `remember` tool removed (2026-04-28).
    // The automatic classifier pipeline in message_received already captures
    // all memorable facts with better quality (proper topics, group scope,
    // Gemini-classified fact_type). The remember tool created duplicates that
    // the dream had to supersede. Not required by the OpenClaw SDK.

    // -------------------------------------------------------------------
    // Tool: archive_search
    // -------------------------------------------------------------------

    api.registerTool({
      name: "archive_search",
      label: "Archive Search",
      description:
        "Search raw transcripts of past conversations. " +
        "CRITICAL: Use ONLY if the user explicitly asks for past chat logs or insists after a failed memory_search. " +
        "NEVER use this on the first round. Returns original messages with context.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for in transcripts",
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default: 10)",
          },
        },
        required: ["query"],
      },
      execute(_toolCallId: string, params: Record<string, unknown>) {
        const database = getDb();
        if (!database) return { content: [{ type: "text", text: "Memory not initialized" }] };

        const query = params.query as string;
        const limit = (params.limit as number) ?? 10;
        const results = searchArchive(database, query, limit);

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No results found in the archive." }] };
        }

        const text = results
          .map(
            (r) =>
              `[${r.timestamp}] ${r.sender_name || "?"}(${r.role}): ${r.message_text}`
          )
          .join("\n");

        return { content: [{ type: "text", text }] };
      },
    });

    // -------------------------------------------------------------------
    // Tool: wiki_status
    // -------------------------------------------------------------------

    api.registerTool({
      name: "wiki_status",
      label: "Wiki Status",
      description:
        "Shows auto-generated wiki status: page count, " +
        "entities, groups, concepts, topics, last update.",
      parameters: {
        type: "object",
        properties: {},
      },
      execute() {
        if (!config) return { content: [{ type: "text", text: "Plugin not initialized" }] };

        const status = getWikiStatus(config);

        const text = [
          "📖 Wiki Status",
          `- Total Topic Pages: ${status.totalPages}`,
          `- Indexed topics: ${status.topicIndexSize}`,
          `- Last updated: ${status.lastUpdated || "never"}`,
          `- Disk size: ${(status.diskSizeBytes / 1024).toFixed(1)} KB`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      },
    });
  }

  // -------------------------------------------------------------------
  // Slash commands
  // -------------------------------------------------------------------

  if (api.registerCommand) {
    // /dream — manual trigger
    api.registerCommand({
      name: "dream",
      description: "Runs a memory consolidation cycle (pass 'rem' for deep)",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx: { args?: string }) => {
        const database = getDb();
        if (!database || !config) return { text: "Plugin not initialized" };

        const type = ctx.args?.trim() === "rem" ? "rem" : "light";
        const report =
          type === "rem"
            ? await dreamRem(api, database, config, ocLog)
            : await dreamLight(database, config, ocLog);

        return {
          text: [
            `🌙 Dream ${report.type} complete`,
            `- Captures processed: ${report.capturesProcessed}`,
            `- Facts created: ${report.factsCreated}`,
            `- Superseded: ${report.factsSuperseded}`,
            report.type === "rem"
              ? `- De-duplicated: ${report.factsDeduplicated}\n` +
                `- Decayed: ${report.factsDecayed}\n` +
                `- Wiki pages updated: ${report.wikiPagesUpdated}`
              : "",
            report.errors.length > 0
              ? `⚠️ Errors: ${report.errors.length}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      },
    });

    // /memory-status — statistics
    api.registerCommand({
      name: "memory-status",
      description: "Shows memory statistics",
      acceptsArgs: false,
      requireAuth: false,
      handler: () => {
        const database = getDb();
        if (!database) return { text: "Plugin not initialized" };

        const facts = database
          .prepare("SELECT COUNT(*) as c FROM facts WHERE is_active = 1")
          .get() as { c: number };
        const captures = database
          .prepare(
            "SELECT COUNT(*) as c FROM session_captures WHERE promoted = 0"
          )
          .get() as { c: number };
        const archive = database
          .prepare("SELECT COUNT(*) as c FROM session_archive")
          .get() as { c: number };
        const superseded = database
          .prepare("SELECT COUNT(*) as c FROM facts WHERE is_active = 0")
          .get() as { c: number };

        return {
          text: [
            "📊 Memory Wiki Engine Status",
            `- Active facts: ${facts.c}`,
            `- Superseded facts: ${superseded.c}`,
            `- Pending captures: ${captures.c}`,
            `- Archived messages: ${archive.c}`,
          ].join("\n"),
        };
      },
    });

    // /set-topic <topic> — force session topic
    api.registerCommand({
      name: "set-topic",
      description: "Forces a topic for the current session",
      acceptsArgs: true,
      requireAuth: false,
      handler: (ctx: { args?: string; sessionKey?: string }) => {
        const database = getDb();
        if (!database) return { text: "Plugin not initialized" };

        const topic = ctx.args?.trim();
        if (!topic) return { text: "Usage: /set-topic <topic>" };

        // Insert a dummy capture with the forced topic
        database.prepare(
          `INSERT INTO session_captures
            (session_id, message_text, fact_text, topics, sender_id,
             owner_type, owner_id, fact_type, is_internal, captured_at, promoted)
           VALUES (?, 'focus', 'focus', ?, 'system', 'global', 'system', 'fact', 0, datetime('now'), 2)`
        ).run(ctx.sessionKey || "unknown", topicsToJson([topic]));

        return { text: `🎯 Topic forced: ${topic}` };
      },
    });

    // /wiki-ingest — ingest from raw/
    api.registerCommand({
      name: "wiki-ingest",
      description:
        "Ingests files from raw/ folder into wiki pages and facts",
      acceptsArgs: false,
      requireAuth: false,
      handler: async () => {
        const database = getDb();
        if (!database || !config) return { text: "Plugin not initialized" };

        const result = await wikiIngest(api, database, config, ocLog);

        return {
          text: [
            "📥 Wiki Ingest complete",
            `- Files processed: ${result.filesProcessed}`,
            `- Pages created: ${result.pagesCreated}`,
            `- Pages updated: ${result.pagesUpdated}`,
            result.errors.length > 0
              ? `⚠️ Errors:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      },
    });
  }

  // -------------------------------------------------------------------
  // Dream scheduling — only when the gateway is running
  // -------------------------------------------------------------------

  if (api.on) {
    api.on("gateway_start", () => {
      if (!config) return;
      // Eagerly init DB when the gateway starts (the primary runtime path)
      const database = getDb();
      if (!database) return;
      ocLog.info(
        `[Memory Wiki Engine] Activated — DB: ${config.dbPath}, Wiki: ${config.wikiPath}`
      );
      scheduleDreams(api, config, database, ocLog);
    });
  }

  // -------------------------------------------------------------------
  // Shutdown hook
  // -------------------------------------------------------------------

  if (api.onShutdown) {
    api.onShutdown(() => {
      if (dreamTimer) clearInterval(dreamTimer);
      if (remTimer) clearTimeout(remTimer);
      if (db) {
        resetStatements();
        dbModule?.closeDatabase(db);
        ocLog.info("[Memory Wiki Engine] DB closed");
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Dream scheduling
// ---------------------------------------------------------------------------

/**
 * Schedules the dreams:
 *   - Light: every N hours (configurable)
 *   - REM: 1x/night at configured time
 */
function scheduleDreams(
  api: any,
  config: PluginConfig,
  db: Database.Database,
  log: any
): void {
  // Light dream — every N hours
  const intervalMs = config.dreamIntervalHours * 60 * 60 * 1000;
  dreamTimer = setInterval(async () => {
    try {
      await dreamLight(db, config, log);
    } catch (error) {
      log.warn("[Dream] Error in scheduled light dream:", error);
    }
  }, intervalMs);
  dreamTimer.unref();

  // REM dream — 1x/night
  scheduleNextRem(api, config, db, log);

  log.info(
    `[Memory Wiki Engine] Dreams scheduled — light: every ${config.dreamIntervalHours}h, ` +
      `REM: ${config.dreamRemTime}`
  );
}

/**
 * Calculates milliseconds until the next REM dream execution
 * and schedules it.
 */
function scheduleNextRem(
  api: any,
  config: PluginConfig,
  db: Database.Database,
  log: any
): void {
  const [hours, minutes] = config.dreamRemTime.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);

  // If the time has already passed today, schedule for tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  const msUntilRem = next.getTime() - now.getTime();

  remTimer = setTimeout(async () => {
    try {
      await dreamRem(api, db, config, log);
    } catch (error) {
      log.warn("[Dream] Error in scheduled REM dream:", error);
    }
    // Reschedule for the next night
    scheduleNextRem(api, config, db, log);
  }, msUntilRem);
  remTimer.unref();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the sender ID from an OpenClaw sessionKey.
 *
 * Format: "agent:main:telegram:direct:7776007798"
 * → returns "7776007798"
 *
 * If the format is unrecognized, returns the full sessionKey.
 */
function extractSenderId(sessionKey: string | undefined): string {
  if (!sessionKey) return "unknown";

  const parts = sessionKey.split(":");
  // The last segment is typically the user ID
  return parts[parts.length - 1] || sessionKey;
}

// ---------------------------------------------------------------------------
// Export for OpenClaw plugin loader
// ---------------------------------------------------------------------------

export default {
  id: "openclaw-memory-wiki-engine",
  name: "Memory Wiki Engine",
  description:
    "Sovereign memory engine with auto-generated wiki, topic-aware classifier, and dream consolidation",
  kind: ["memory", "context-engine"] as const,
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      embeddingUrl: { type: "string" },
      embeddingModel: { type: "string" },
      debug: { type: "boolean" },
    },
  },
  register,
};
