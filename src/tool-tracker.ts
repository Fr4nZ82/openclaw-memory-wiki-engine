/**
 * tool-tracker.ts — JSONL audit parser
 *
 * Legge i file JSONL di sessione degli agent (`~/.openclaw/agents/<name>/sessions/*.jsonl`),
 * estrae gli eventi `tool_call` (e correla `tool_result` quando possibile),
 * e popola la tabella `tool_executions`.
 *
 * Idempotente:
 *   - Lo stato del parser vive in `jsonl_parser_state(source_file, last_byte_offset)`.
 *   - I file JSONL sono append-only, quindi byte_offset è sufficiente per riprendere.
 *   - Schedulato ogni 60s da `index.ts`.
 *
 * Output: alimenta `tool_log_search` (vedi index.ts) con UNION tra `tool_log` e
 * `tool_executions` — Sam può rispondere a "cosa hai fatto" guardando azioni reali.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type Database from "better-sqlite3";
import { dbg } from "./debug";

const dlog = dbg("tool-tracker");

const AGENTS_DIR = path.join(os.homedir(), ".openclaw", "agents");
const MAX_ARGS_LEN = 4096;
const MAX_RESULT_LEN = 512;

interface JsonlEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  // tool_call
  name?: string;
  arguments?: any;
  input?: any;
  // tool_result
  error?: any;
  isError?: boolean;
  content?: any;
  output?: any;
  // session
  cwd?: string;
}

/**
 * Estrae il sessionId dal nome file (UUID prima di `.jsonl`) come fallback.
 * Il `session.id` interno è uguale al filename, quindi prendere il filename è sicuro.
 */
function sessionIdFromFile(filePath: string): string {
  const fname = path.basename(filePath);
  return fname.replace(/\.jsonl(\.deleted\..*)?$/, "");
}

/** Estrai testo dal content/output (può essere stringa, array di parti, dict). */
function extractText(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(c => (typeof c === "string" ? c : (c?.text ?? c?.content ?? "")))
      .filter(Boolean)
      .join(" ");
  }
  if (typeof content === "object") {
    return content.text || content.content || JSON.stringify(content);
  }
  return String(content);
}

/**
 * Esegue una passata di parsing su tutti i JSONL agent. Idempotente.
 * @returns numero di tool_executions inserite
 */
export function syncToolExecutions(db: Database.Database, logger: any): number {
  if (!fs.existsSync(AGENTS_DIR)) {
    dlog(`Agents dir not found: ${AGENTS_DIR}`);
    return 0;
  }

  const stateGet = db.prepare(
    `SELECT last_byte_offset FROM jsonl_parser_state WHERE source_file = ?`
  );
  const stateUpsert = db.prepare(
    `INSERT INTO jsonl_parser_state (source_file, last_byte_offset, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(source_file) DO UPDATE SET
       last_byte_offset = excluded.last_byte_offset,
       updated_at = datetime('now')`
  );
  const insertExec = db.prepare(
    `INSERT INTO tool_executions
       (session_id, agent_name, call_id, tool_name, tool_args_json,
        result_summary, is_error, source_file, timestamp)
     VALUES (@session_id, @agent_name, @call_id, @tool_name, @tool_args_json,
             @result_summary, @is_error, @source_file, @timestamp)`
  );
  // Portable form (no ORDER BY in UPDATE): correlate result to the latest
  // pending tool_call with the same call_id via a subquery.
  const updateResult = db.prepare(
    `UPDATE tool_executions
     SET result_summary = @result_summary, is_error = @is_error
     WHERE id = (
       SELECT id FROM tool_executions
       WHERE call_id = @call_id AND result_summary IS NULL
       ORDER BY id DESC LIMIT 1
     )`
  );

  let totalInserted = 0;

  for (const agentName of fs.readdirSync(AGENTS_DIR)) {
    const sessDir = path.join(AGENTS_DIR, agentName, "sessions");
    if (!fs.existsSync(sessDir) || !fs.statSync(sessDir).isDirectory()) continue;

    for (const fname of fs.readdirSync(sessDir)) {
      // Skip non-jsonl and `.deleted` files (sessions soft-deleted)
      if (!fname.endsWith(".jsonl")) continue;

      const filePath = path.join(sessDir, fname);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }

      const lastOffsetRow = stateGet.get(filePath) as { last_byte_offset: number } | undefined;
      const lastOffset = lastOffsetRow?.last_byte_offset ?? 0;

      // File shrunk (rotazione/compaction) → reset
      if (stat.size < lastOffset) {
        dlog(`File shrunk, resetting offset: ${filePath} (${stat.size} < ${lastOffset})`);
        stateUpsert.run(filePath, 0);
        continue; // riprenderemo dalla prossima call
      }

      if (stat.size <= lastOffset) continue; // nothing new

      let buffer: Buffer;
      try {
        const fd = fs.openSync(filePath, "r");
        const sizeToRead = stat.size - lastOffset;
        buffer = Buffer.alloc(sizeToRead);
        fs.readSync(fd, buffer, 0, sizeToRead, lastOffset);
        fs.closeSync(fd);
      } catch (e) {
        dlog(`Read failed for ${filePath}: ${e}`);
        continue;
      }

      const sessionId = sessionIdFromFile(filePath);

      // Parsa linea per linea. Se l'ultima linea è troncata (file in scrittura),
      // ne salviamo l'offset prima della troncatura per la prossima passata.
      const text = buffer.toString("utf-8");
      const lines = text.split("\n");

      let consumed = 0; // bytes consumati con successo
      const insertMany = db.transaction(() => {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Ultima linea senza newline finale = potenziale troncatura → skip
          // (la rileggeremo alla prossima passata quando il newline arriverà)
          const isLast = i === lines.length - 1;
          if (isLast && !text.endsWith("\n") && line.length > 0) {
            // Non avanzare oltre questa linea
            break;
          }
          consumed += Buffer.byteLength(line, "utf-8") + 1; // +1 per "\n"

          const trimmed = line.trim();
          if (!trimmed) continue;

          let entry: JsonlEntry;
          try {
            entry = JSON.parse(trimmed);
          } catch {
            continue;
          }

          if (entry.type === "tool_call") {
            const toolName = entry.name || "unknown";
            const args = entry.arguments ?? entry.input ?? {};
            let argsJson = "";
            try {
              argsJson = JSON.stringify(args);
            } catch {
              argsJson = String(args);
            }
            if (argsJson.length > MAX_ARGS_LEN) {
              argsJson = argsJson.substring(0, MAX_ARGS_LEN) + "…[truncated]";
            }

            insertExec.run({
              session_id: sessionId,
              agent_name: agentName,
              call_id: entry.id || null,
              tool_name: toolName,
              tool_args_json: argsJson,
              result_summary: null,
              is_error: 0,
              source_file: filePath,
              timestamp: entry.timestamp || new Date().toISOString(),
            });
            totalInserted++;
          } else if (entry.type === "tool_result") {
            // Correla per parentId (id del tool_call originario)
            const callId = entry.parentId;
            if (!callId) continue;

            const isError = !!(entry.error || entry.isError);
            let resultText = extractText(entry.content ?? entry.output);
            if (resultText.length > MAX_RESULT_LEN) {
              resultText = resultText.substring(0, MAX_RESULT_LEN) + "…[truncated]";
            }

            updateResult.run({
              call_id: callId,
              result_summary: resultText || null,
              is_error: isError ? 1 : 0,
            });
          }
        }

        // Aggiorna offset
        const newOffset = lastOffset + consumed;
        stateUpsert.run(filePath, newOffset);
      });
      insertMany();
    }
  }

  if (totalInserted > 0) {
    logger.info(`[ToolTracker] +${totalInserted} tool_executions sincronizzate dai JSONL agent`);
  }
  return totalInserted;
}
