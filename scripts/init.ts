#!/usr/bin/env npx tsx
/**
 * init.ts — Bootstrap wiki-engine from OpenClaw workspace
 *
 * Reads USER.md, MEMORY.md, and memory/*.md from the workspace,
 * uses Gemini Flash to extract structured facts, inserts them
 * into the engine DB, and backs up/removes memory files.
 *
 * Usage:
 *   npx tsx scripts/init.ts [--db <path>] [--dry-run] [--workspace <path>]
 *
 * Run ONCE after enrollment, before the system starts receiving
 * organic messages.
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtractedFact {
  fact_text: string;
  fact_type: "fact" | "preference" | "rule" | "episode";
  owner_type: "user" | "group" | "global";
  owner_id: string;
  topics: string[];
  confidence: number;
}

interface UserRow {
  sender_id: string;
  names: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolveDbPath(explicit?: string): string {
  if (explicit) return explicit;
  const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
  return path.join(home, "wiki-engine", "engine.db");
}

function resolveWorkspacePath(explicit?: string): string {
  if (explicit) return explicit;
  const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
  return path.join(home, "workspace");
}

function readEnvFile(): Record<string, string> {
  const result: Record<string, string> = {};

  // Check both: plugin dir and OPENCLAW_HOME
  const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
  const candidates = [
    path.join(__dirname, "..", ".env"),       // plugin root
    path.join(openclawHome, ".env"),          // ~/.openclaw/.env
  ];

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const envContent = fs.readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...rest] = trimmed.split("=");
      const val = rest.join("=").trim().replace(/^["']|["']$/g, "");
      if (key.trim() && val) result[key.trim()] = val;
    }
  }
  return result;
}

function resolveApiKey(env: Record<string, string>): string {
  const key = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY;
  if (key) return key;

  const envPath = path.join(__dirname, "..", ".env");
  throw new Error(
    `Cannot find GEMINI_API_KEY. Create a .env file in the plugin root or set the env var.\n` +
    `  echo 'GEMINI_API_KEY=your-key' > ${envPath}`
  );
}

function resolveEmbeddingUrl(): string {
  const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
  const configPath = path.join(home, "openclaw.json");

  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const pluginConfig = config?.plugins?.entries?.["openclaw-memory-wiki-engine"]?.config;
      if (pluginConfig?.ollamaUrl) return pluginConfig.ollamaUrl;
    } catch { /* fall through to default */ }
  }

  return "http://localhost:11434";
}

// ---------------------------------------------------------------------------
// Ensure DB schema
// ---------------------------------------------------------------------------

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      sender_id TEXT PRIMARY KEY,
      names     TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id          TEXT PRIMARY KEY,
      fact_text   TEXT NOT NULL,
      fact_type   TEXT NOT NULL DEFAULT 'fact',
      owner_type  TEXT NOT NULL DEFAULT 'user',
      owner_id    TEXT NOT NULL,
      topics      TEXT,
      confidence  REAL NOT NULL DEFAULT 1.0,
      source      TEXT NOT NULL DEFAULT 'init',
      embedding   BLOB,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      superseded_by TEXT,
      active      INTEGER NOT NULL DEFAULT 1
    )
  `);
}

// ---------------------------------------------------------------------------
// Read workspace files
// ---------------------------------------------------------------------------

interface WorkspaceContent {
  userMd: string | null;
  memoryMd: string | null;
  dailyNotes: Array<{ filename: string; content: string }>;
}

function readWorkspace(workspacePath: string): WorkspaceContent {
  const result: WorkspaceContent = {
    userMd: null,
    memoryMd: null,
    dailyNotes: [],
  };

  // USER.md
  const userPath = path.join(workspacePath, "USER.md");
  if (fs.existsSync(userPath)) {
    result.userMd = fs.readFileSync(userPath, "utf-8");
    console.log(`📄 Read USER.md (${result.userMd.length} chars)`);
  }

  // MEMORY.md
  const memoryPath = path.join(workspacePath, "MEMORY.md");
  if (fs.existsSync(memoryPath)) {
    result.memoryMd = fs.readFileSync(memoryPath, "utf-8");
    console.log(`📄 Read MEMORY.md (${result.memoryMd.length} chars)`);
  }

  // memory/*.md
  const memoryDir = path.join(workspacePath, "memory");
  if (fs.existsSync(memoryDir) && fs.statSync(memoryDir).isDirectory()) {
    const files = fs.readdirSync(memoryDir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    for (const file of files) {
      const content = fs.readFileSync(path.join(memoryDir, file), "utf-8");
      // Skip tiny placeholder files (171 bytes = empty template)
      if (content.length > 200) {
        result.dailyNotes.push({ filename: file, content });
        console.log(`📄 Read memory/${file} (${content.length} chars)`);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Gemini API call
// ---------------------------------------------------------------------------

async function callGemini(apiKey: string, prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json() as any;
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error("Gemini returned empty response");
  }

  return text;
}

// ---------------------------------------------------------------------------
// Fact extraction via LLM
// ---------------------------------------------------------------------------

function buildExtractionPrompt(
  workspace: WorkspaceContent,
  knownUsers: Array<{ sender_id: string; canonical: string; names: string[] }>
): string {
  const usersList = knownUsers
    .map((u) => `- ${u.canonical} (aliases: ${u.names.join(", ")}, sender_id: ${u.sender_id})`)
    .join("\n");

  const parts: string[] = [];

  if (workspace.userMd) {
    parts.push(`## FILE: USER.md\n\n${workspace.userMd}`);
  }
  if (workspace.memoryMd) {
    parts.push(`## FILE: MEMORY.md\n\n${workspace.memoryMd}`);
  }
  for (const note of workspace.dailyNotes) {
    // Truncate very long daily notes to avoid token explosion
    const truncated = note.content.length > 5000
      ? note.content.substring(0, 5000) + "\n...(truncated)"
      : note.content;
    parts.push(`## FILE: memory/${note.filename}\n\n${truncated}`);
  }

  return `You are a fact extractor for a family AI assistant's memory system.

## Known users (enrolled in the system)

${usersList}

## Known groups

- famiglia (Family group)
- admin (System administrators)
- amici (Friends)

## Workspace files to analyze

${parts.join("\n\n---\n\n")}

## Instructions

Extract ALL structured facts from these files. Each fact should be a discrete, self-contained piece of information.

Focus on:
- Biographical data (birth dates, relationships, professions)
- Preferences and tastes
- Rules that affect the assistant's behavior
- Family relationships
- Permissions and restrictions per user
- Medical/health information
- Current episodes or temporary states

Do NOT extract:
- System configuration details (ports, paths, services)
- Technical implementation details
- The assistant's personality or identity (SOUL.md stuff)
- Tool descriptions
- Identity map (already in DB)

## Output format

Return a JSON array of facts:

[
  {
    "fact_text": "Daniel's birthday is October 31, 2017 (8 years old)",
    "fact_type": "fact",
    "owner_type": "user",
    "owner_id": "gollum",
    "topics": ["birthday", "gollum"],
    "confidence": 1.0
  },
  {
    "fact_text": "Galadriel must not receive images of spiders",
    "fact_type": "rule",
    "owner_type": "user",
    "owner_id": "galadriel",
    "topics": ["rules", "galadriel"],
    "confidence": 1.0
  }
]

Rules for owner_id:
- Use the CANONICAL NAME (first name, lowercase) from the known users list
- For family-wide facts → owner_type: "group", owner_id: "famiglia"
- For system-wide rules → owner_type: "global", owner_id: "global"
- owner_id must be lowercase

Rules for fact_type:
- "fact" — objective, persistent information
- "preference" — taste, like/dislike
- "rule" — changes the assistant's behavior
- "episode" — temporary state (medical recovery, currently reading a book)

Respond ONLY with the JSON array, no markdown fences, no explanations.`;
}

// ---------------------------------------------------------------------------
// Embedding generation (Ollama)
// ---------------------------------------------------------------------------

async function generateEmbedding(
  text: string,
  embeddingUrl: string
): Promise<Buffer | null> {
  try {
    const response = await fetch(`${embeddingUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "nomic-embed-text",
        prompt: text,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as { embedding: number[] };
    if (!data.embedding) return null;

    // Pack floats into a binary buffer for SQLite
    const buf = Buffer.alloc(data.embedding.length * 4);
    for (let i = 0; i < data.embedding.length; i++) {
      buf.writeFloatLE(data.embedding[i], i * 4);
    }
    return buf;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backup and cleanup
// ---------------------------------------------------------------------------

function backupAndClean(workspacePath: string, dryRun: boolean): void {
  const backupDir = path.join(workspacePath, ".memory-backup");

  const memoryMdPath = path.join(workspacePath, "MEMORY.md");
  const memoryDirPath = path.join(workspacePath, "memory");

  if (dryRun) {
    console.log("\n🔒 [DRY RUN] Would backup and remove:");
    if (fs.existsSync(memoryMdPath)) console.log(`   - MEMORY.md → .memory-backup/MEMORY.md`);
    if (fs.existsSync(memoryDirPath)) console.log(`   - memory/ → .memory-backup/memory/`);
    return;
  }

  if (!fs.existsSync(memoryMdPath) && !fs.existsSync(memoryDirPath)) {
    console.log("ℹ️  No memory files to clean up");
    return;
  }

  // Create backup dir
  fs.mkdirSync(backupDir, { recursive: true });

  // Backup MEMORY.md
  if (fs.existsSync(memoryMdPath)) {
    fs.copyFileSync(memoryMdPath, path.join(backupDir, "MEMORY.md"));
    fs.unlinkSync(memoryMdPath);
    console.log("📦 Backed up and removed MEMORY.md");
  }

  // Backup memory/
  if (fs.existsSync(memoryDirPath)) {
    const backupMemDir = path.join(backupDir, "memory");
    fs.mkdirSync(backupMemDir, { recursive: true });

    const files = fs.readdirSync(memoryDirPath);
    for (const file of files) {
      fs.copyFileSync(
        path.join(memoryDirPath, file),
        path.join(backupMemDir, file)
      );
    }
    fs.rmSync(memoryDirPath, { recursive: true });
    console.log(`📦 Backed up and removed memory/ (${files.length} files)`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage:
  npx tsx scripts/init.ts               Bootstrap from workspace
  npx tsx scripts/init.ts --dry-run     Show what would be extracted (no writes)

Options:
  --db <path>        Path to engine.db (default: ~/.openclaw/wiki-engine/engine.db)
  --workspace <path> Path to workspace (default: ~/.openclaw/workspace)
  --dry-run          Extract and display facts without writing to DB or removing files
  --help             Show this help

This command:
1. Reads USER.md, MEMORY.md, and memory/*.md from the workspace
2. Uses Gemini Flash to extract structured facts
3. Inserts facts into the engine DB with embeddings
4. Backs up MEMORY.md and memory/ to .memory-backup/
5. Removes MEMORY.md and memory/ from the workspace

Run ONCE after enrollment. After init, trigger a dream to generate wiki pages:
  openclaw plugins run openclaw-memory-wiki-engine dream --mode rem
    `.trim());
    process.exit(0);
  }

  const dryRun = args.includes("--dry-run");
  const dbIdx = args.indexOf("--db");
  const explicitDb = dbIdx >= 0 ? args[dbIdx + 1] : undefined;
  const wsIdx = args.indexOf("--workspace");
  const explicitWs = wsIdx >= 0 ? args[wsIdx + 1] : undefined;

  const dbPath = resolveDbPath(explicitDb);
  const workspacePath = resolveWorkspacePath(explicitWs);

  console.log(`🔧 DB: ${dbPath}`);
  console.log(`📂 Workspace: ${workspacePath}`);
  console.log(`${dryRun ? "🔒 DRY RUN — no writes" : "✏️  LIVE — will write to DB and clean up"}`);
  console.log("");

  // Validate paths
  if (!fs.existsSync(dbPath)) {
    console.error(`❌ Database not found: ${dbPath}`);
    console.error("   Start the gateway once to initialize the database, then run enrollment.");
    process.exit(1);
  }

  if (!fs.existsSync(workspacePath)) {
    console.error(`❌ Workspace not found: ${workspacePath}`);
    process.exit(1);
  }

  // Open DB
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  ensureSchema(db);

  try {
    // Check enrollment
    const users = db
      .prepare("SELECT sender_id, names FROM users")
      .all() as UserRow[];

    if (users.length === 0) {
      console.error("❌ No users enrolled. Run enroll.ts first.");
      process.exit(1);
    }

    const knownUsers = users.map((u) => {
      const names = JSON.parse(u.names) as string[];
      return {
        sender_id: u.sender_id,
        canonical: names[0] || u.sender_id,
        names,
      };
    });

    console.log(`👥 ${knownUsers.length} enrolled user(s): ${knownUsers.map((u) => u.canonical).join(", ")}`);
    console.log("");

    // Read workspace
    const workspace = readWorkspace(workspacePath);

    if (!workspace.userMd && !workspace.memoryMd && workspace.dailyNotes.length === 0) {
      console.log("ℹ️  No workspace files to process. Nothing to do.");
      process.exit(0);
    }

    // Get API key and embedding URL from .env
    const env = readEnvFile();
    console.log("\n🤖 Calling Gemini Flash to extract facts...");
    const apiKey = resolveApiKey(env);
    const embeddingUrl = resolveEmbeddingUrl();

    // Build prompt and call LLM
    const prompt = buildExtractionPrompt(workspace, knownUsers);
    const response = await callGemini(apiKey, prompt);

    // Parse facts
    let facts: ExtractedFact[];
    try {
      facts = JSON.parse(response);
      if (!Array.isArray(facts)) {
        throw new Error("Response is not an array");
      }
    } catch (e) {
      console.error("❌ Failed to parse LLM response:");
      console.error(response.substring(0, 500));
      process.exit(1);
    }

    console.log(`\n📋 Extracted ${facts.length} fact(s):\n`);

    for (const fact of facts) {
      const typeEmoji = {
        fact: "📌",
        preference: "💚",
        rule: "⚠️",
        episode: "📅",
      }[fact.fact_type] || "•";

      console.log(`  ${typeEmoji} [${fact.owner_type}/${fact.owner_id}] ${fact.fact_text}`);
    }

    if (dryRun) {
      backupAndClean(workspacePath, true);
      console.log("\n🔒 [DRY RUN] No changes made. Remove --dry-run to apply.");
      process.exit(0);
    }

    // Insert facts
    console.log("\n💾 Inserting facts into DB...");

    const insertFact = db.prepare(`
      INSERT OR IGNORE INTO facts (id, fact_text, fact_type, owner_type, owner_id, topics, confidence, source, embedding)
      VALUES (@id, @fact_text, @fact_type, @owner_type, @owner_id, @topics, @confidence, 'init', @embedding)
    `);

    // Generate embeddings via Ollama
    let embeddingsOk = 0;
    let embeddingsFailed = 0;

    const tx = db.transaction(() => {
      for (const fact of facts) {
        const id = crypto.randomUUID();
        insertFact.run({
          id,
          fact_text: fact.fact_text,
          fact_type: fact.fact_type,
          owner_type: fact.owner_type,
          owner_id: fact.owner_id.toLowerCase(),
          topics: JSON.stringify(fact.topics || []),
          confidence: fact.confidence ?? 1.0,
          embedding: null, // embeddings added in next pass
        });
      }
    });

    tx();
    console.log(`✅ Inserted ${facts.length} fact(s)`);

    // Generate embeddings (async, outside transaction)
    console.log("\n🧠 Generating embeddings...");

    const updateEmbedding = db.prepare(
      "UPDATE facts SET embedding = ? WHERE fact_text = ? AND source = 'init'"
    );

    for (const fact of facts) {
      const emb = await generateEmbedding(fact.fact_text, embeddingUrl);
      if (emb) {
        updateEmbedding.run(emb, fact.fact_text);
        embeddingsOk++;
      } else {
        embeddingsFailed++;
      }
    }

    if (embeddingsOk > 0) {
      console.log(`✅ Generated ${embeddingsOk} embedding(s)`);
    }
    if (embeddingsFailed > 0) {
      console.log(`⚠️  ${embeddingsFailed} embedding(s) failed (Ollama offline? Search will use BM25 only)`);
    }

    // Backup and clean
    console.log("");
    backupAndClean(workspacePath, false);

    console.log("\n🎉 Init complete! Next steps:");
    console.log("   1. Trigger a dream to generate wiki pages:");
    console.log("      openclaw plugins run openclaw-memory-wiki-engine dream --mode rem");
    console.log("   2. Verify with: npx tsx scripts/enroll.ts --dump");

  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("❌ Fatal error:", err.message);
  process.exit(1);
});
