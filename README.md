# openclaw-memory-wiki-engine

A sovereign memory plugin for [OpenClaw](https://docs.openclaw.ai/) that replaces the built-in `memory-core` with a 5-layer architecture: **Wiki → Facts DB → Session Captures → MEMORY.md → Archive**.

Instead of dumping everything into a flat memory store, this plugin **classifies** each message by topic, **captures** only meaningful facts, **builds** a searchable auto-generated wiki, and **consolidates** knowledge overnight via a dream engine.

## Features

- **Multi-user / multi-tenant** — each user's memory is isolated by sender ID, with support for group-level and global facts; cross-user attribution lets one user store facts about another (see [Multi-user architecture](#multi-user-architecture))
- **Topic-aware classifier** — LLM-powered message classification with multi-topic tagging, cross-user attribution, and task/internal filtering
- **Hybrid search** — BM25 full-text + vector embedding (Ollama) with 5-priority context injection
- **Auto-generated wiki** — entity/group/concept pages created and updated automatically from accumulated facts
- **Dream consolidation** — lightweight (every 6h) and deep REM (nightly) cycles for fact promotion, supersedence, deduplication, and confidence decay
- **Supersedence** — new facts automatically override contradicted old ones (never deleted, just marked inactive)
- **MEMORY.md** — auto-generated operational rules file for quick agent reference
- **SQLite-based** — single `engine.db` file with FTS5, vector columns, and migration system
- **Graceful degradation** — works without Ollama (falls back to keyword search)

## Architecture

```
Message → Archive → Classifier → Capture
                                     ↓
                              Dream (6h/nightly)
                                     ↓
                              Facts DB + Wiki
                                     ↓
                              Recall → Prompt
```

| Layer | Purpose | Storage |
|-------|---------|---------|
| Wiki | Structured pages per entity/group/concept | `wiki/` filesystem |
| Facts DB | Permanent knowledge with embeddings | `facts` table |
| Captures | Pre-promotion classified snippets | `session_captures` table |
| MEMORY.md | Operational rules (auto-generated) | filesystem |
| Archive | Raw message log with FTS5 | `session_archive` table |

## Installation

### From GitHub (recommended)

```bash
# Clone the repo anywhere on the machine
git clone https://github.com/Fr4nZ82/openclaw-memory-wiki-engine.git
cd openclaw-memory-wiki-engine

# Install dependencies and build
npm install
npm run build

# Register the plugin with OpenClaw
openclaw plugins install ./
```

### Alternative: dev linking via load.paths

If you prefer to keep the repo in a custom location and avoid copying:

```bash
# Point OpenClaw to the plugin directory
openclaw config set plugins.load.paths '["/path/to/openclaw-memory-wiki-engine"]'
```

### Activate as memory provider

Replace the default `memory-core` by setting the memory slot:

```bash
openclaw config set plugins.slots.memory "openclaw-memory-wiki-engine"
openclaw gateway restart
```

### User enrollment

The plugin supports multi-user memory with group-based scoping. After installation, enroll your users and groups using the CLI tool:

**1. Create a `users.json` file** (see `scripts/users.example.json`):

```json
{
  "users": [
    { "sender_id": "alice", "names": ["Alice"] },
    { "sender_id": "bob", "names": ["Bob", "Roberto"] },
    { "sender_id": "charlie", "names": ["Charlie", "Carlo"] }
  ],
  "groups": [
    {
      "id": "family",
      "name": "Family",
      "description": "Core family group",
      "scope": [
        "Spesa e lista della spesa",
        "Regole della casa (orari, turni)",
        "Piani condivisi (vacanze, cene, uscite)"
      ],
      "members": ["alice", "bob", "charlie"]
    }
  ]
}
```

### Users

| Field | Required | Description |
|-------|----------|-------------|
| `sender_id` | ✅ | User identifier as seen by OpenClaw (Telegram numeric ID, Discord ID, etc.) |
| `names` | ✅ | Array of names. **First = canonical** (used as `owner_id` in facts and wiki page slug). Others = aliases for cross-user attribution. |

> The classifier receives all names in its prompt. When a user says "Francesco likes coffee", the classifier looks up "Francesco" in the known users list, finds it's an alias for "Frodo", and sets `owner_id: "frodo"`.

### Groups

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Unique group identifier (used in DB and wiki paths) |
| `name` | ✅ | Human-readable group name |
| `description` | ❌ | Optional description |
| `scope` | ❌ | Array of strings: what types of facts belong to this group (vs individual profiles). Used by the dream engine to generate the "Scope" section in group wiki pages. |
| `members` | ✅ | Array of `sender_id` references (must be defined in `users` first) |

> **Note**: `sender_id` must match the ID that OpenClaw assigns to incoming messages. For Telegram this is typically the numeric user ID; check your channel's message metadata to confirm.

**2. Run the enrollment script:**

```bash
cd openclaw-memory-wiki-engine

# Import users and groups
npx tsx scripts/enroll.ts users.json

# Verify what's in the DB
npx tsx scripts/enroll.ts --dump

# Use a custom DB path if needed
npx tsx scripts/enroll.ts users.json --db /path/to/engine.db
```

The operation is **idempotent** — you can edit `users.json` and re-run at any time. Users/members present in the DB but removed from the file will be cleaned up automatically.

**3. Edit cycle:** to update users/groups later, dump → edit → re-import:

```bash
npx tsx scripts/enroll.ts --dump > users.json
# edit users.json
npx tsx scripts/enroll.ts users.json
```

## Configuration

All settings are optional — defaults work out of the box. Configure via `openclaw.json` under `plugins.entries`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-memory-wiki-engine": {
        "config": {
          "embeddingUrl": "http://localhost:11434",
          "embeddingModel": "nomic-embed-text",
          "dreamIntervalHours": 6,
          "dreamRemTime": "03:00",
          "contextBudget": 1100,
          "keepTurns": 4
        }
      }
    }
  }
}
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `dbPath` | `~/.openclaw/wiki-engine/engine.db` | SQLite database path |
| `wikiPath` | `~/.openclaw/wiki-engine/wiki/` | Auto-generated wiki directory |
| `rawPath` | `~/.openclaw/wiki-engine/raw/` | Ingest source directory |
| `embeddingUrl` | `http://localhost:11434` | Ollama server URL |
| `embeddingModel` | `nomic-embed-text` | Ollama model for embeddings |
| `embeddingDimensions` | `768` | Embedding vector size |
| `contextBudget` | `1100` | Max tokens injected per prompt |
| `keepTurns` | `4` | Conversation turns to keep (compaction) |
| `classifierModel` | `flash` | LLM model for classification |
| `classifierContextWindow` | `5` | Messages to include in classifier context |
| `dreamIntervalHours` | `6` | Hours between light dream cycles |
| `dreamRemTime` | `03:00` | Time for nightly deep dream (HH:MM) |
| `minMessageLength` | `10` | Min chars to classify a message |
| `maxMessageLength` | `2000` | Max chars sent to classifier |

### Ollama setup (optional, recommended)

For vector search, install [Ollama](https://ollama.ai/) and pull the embedding model:

```bash
ollama pull nomic-embed-text
```

If Ollama is not available, the plugin degrades gracefully to keyword-only search (BM25).

## Tools

The plugin registers these tools for the agent:

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid search across facts, wiki, and captures |
| `remember` | Explicitly save a fact to memory |
| `archive_search` | Full-text search in raw message transcripts |
| `wiki_status` | Wiki statistics (pages, topics, disk size) |

## Commands

| Command | Description |
|---------|-------------|
| `/dream` | Trigger a manual dream cycle (`/dream rem` for deep) |
| `/memory-status` | Show memory statistics |
| `/focus <topic>` | Force a topic for the current session |
| `/wiki-ingest` | Process files from `raw/` into wiki pages or facts |
| `/wiki-lint` | Health check: stale pages, orphans, gaps |
| `/wiki-sync` | Incremental wiki update from recent facts |

## How it works

### Capture pipeline

1. Every user message is **archived** (raw transcript, always)
2. The **classifier** (Gemini Flash via `llm-task`) analyzes the message:
   - Assigns 1-3 topics
   - Detects fact type (fact/preference/rule/episode)
   - Flags tasks (routed to skills, not stored)
   - Handles cross-user attribution ("Bob doesn't like pesto" → attributed to Bob)
3. Memorable messages are saved as **captures** (pending promotion)

### Dream engine

- **Light dream** (every 6h): promotes captures to permanent facts, generates embeddings, checks supersedence
- **REM dream** (nightly at 03:00): deduplication (cosine > 0.85), confidence decay (>90 days unused), wiki page generation, MEMORY.md update, archive compression (>6 months)

### Recall (context injection)

Before each prompt, the plugin injects relevant context with 5 priority layers:

1. **MEMORY.md** — operational rules (always loaded)
2. **Routing hints** — skill/action routing cues
3. **Wiki pages** — matching entity/concept pages
4. **Hybrid search** — BM25 + vector results from facts
5. **Session captures** — current session context

Total budget is ~1100 tokens (configurable), distributed across layers with graceful truncation.

### Multi-user architecture

The engine is designed from the ground up for **multi-user** environments (families, teams, shared assistants). Every fact is tagged with an **owner**, enabling per-user isolation and cross-user attribution:

| Owner type | Scope | Example |
|------------|-------|---------|
| `user` | Private to one person | "Alice does karate" → owned by `alice` |
| `group` | Shared within a group | "We need detergent" → owned by `family` |
| `global` | Visible to all users | "The WiFi password is ..." → owned by `system` |

**Cross-user attribution** — when user A says *"Bob doesn't like pesto"*, the classifier attributes the fact to `bob`, not to the sender. This means Bob's wiki page and recall context reflect the preference correctly, even though Bob didn't say it himself.

**Recall scoping** — during context injection, each user sees:
- Their own facts (`owner_id = sender_id`)
- Group facts they belong to (`owner_type = 'group'`)
- Global facts (`owner_type = 'global'`)

Facts from other users are **never** leaked into someone else's prompt.

**Wiki pages** — the dream engine auto-generates a wiki page per entity under `wiki/entities/`, per group under `wiki/groups/`, and per concept under `wiki/concepts/`. Each page aggregates all active facts for that owner, organized by type (rules, preferences, facts, episodes).

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production build
```

## Requirements

- Node.js ≥ 20
- OpenClaw ≥ 2026.4.0
- Ollama (optional, for vector search)

## License

MIT
