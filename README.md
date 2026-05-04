# openclaw-memory-wiki-engine

A sovereign memory plugin for [OpenClaw](https://docs.openclaw.ai/) that replaces the built-in `memory-core` with a 5-layer architecture: **Wiki → Facts DB → Session Captures → Archive**.

Instead of dumping everything into a flat memory store, this plugin **classifies** each message by topic, **captures** only meaningful facts, **builds** a searchable auto-generated wiki, and **consolidates** knowledge overnight via a dream engine.

## Features

- **Multi-user / multi-tenant** — each user's memory is isolated by sender ID, with support for group-level and global facts; cross-user attribution lets one user store facts about another (see [Multi-user architecture](#multi-user-architecture))
- **Topic-aware classifier** — LLM-powered message classification with multi-topic tagging, cross-user attribution, and task/internal filtering
- **Hybrid search** — BM25 full-text + vector embedding (Ollama) with 5-priority context injection
- **Auto-generated wiki** — entity/group/concept pages created and updated automatically from accumulated facts
- **Dream consolidation** — lightweight (every 6h) and deep REM (nightly) cycles for fact promotion, supersedence, deduplication, and confidence decay
- **Supersedence** — new facts automatically override contradicted old ones (never deleted, just marked inactive)
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

### Recommended OpenClaw configuration

The plugin registers a custom compaction provider (`wiki-engine-truncate`) that **truncates** conversation history to `keepTurns` messages instead of running an LLM summarization pass. To activate it and disable redundant native mechanisms:

```bash
# 1. Use the plugin's truncation provider instead of LLM-based summarization
openclaw config set agents.defaults.compaction.provider wiki-engine-truncate

# 2. Disable the pre-compaction memory flush (LLM turn that saves context — redundant with this plugin)
openclaw config set agents.defaults.compaction.memoryFlush.enabled false

# 3. Disable the session-memory hook (LLM-based slug generation on /new or /reset — redundant)
openclaw hooks disable session-memory

# 4. (Optional) Force compaction to trigger sooner on large context windows (e.g. Gemini 1M)
# Default reserveTokens is ~16K, meaning compaction triggers at ~984K tokens — effectively never.
# Setting 980000 triggers compaction at ~20K total context (~15 messages of history).
openclaw config set agents.defaults.compaction.reserveTokens 980000

# Apply changes
openclaw gateway restart
```

> **Why?** Without these settings, OpenClaw runs 2 redundant LLM calls per session lifecycle:
> a silent "memory flush" turn before each compaction, and a `session-memory` hook that
> generates slug-based summaries on `/new`/`/reset`. Since this plugin already persists
> all facts, captures, and wiki pages, those LLM calls are pure waste.

### User enrollment (USERS.md)

The plugin supports multi-user memory with group-based scoping. Users and groups are declared in a single `USERS.md` file in the workspace — **no separate JSON or CLI scripts needed**.

**1. Create `USERS.md` in your workspace** (e.g. `~/.openclaw/workspace/USERS.md`):

```markdown
# USERS

## Gruppi

### admin
- permissions: full
- description: Full access. Can invoke sub-agents, exec, system, cron.

### family
- description: Core family group
- permissions: chat, ask_admin, calendar, memory
- scope: Groceries and shopping list; House rules; Shared plans

---

## alice
- sender_id: 123456789
- channel: telegram
- aliases: Alicia, Ali
- groups: family, admin
- relazioni: partner of Bob, mother of Charlie
- born: 1990-01-15

### Profilo
Direct communication, no sugar-coating. Practical solutions > theoretical ones.

---

## bob
- sender_id: 987654321
- channel: telegram
- aliases: Roberto
- groups: family
- relazioni: partner of Alice, father of Charlie

### Profilo
Friendly and patient. Prefers step-by-step explanations.
```

### Users

| Field | Required | Description |
|-------|----------|-------------|
| `sender_id` | ✅ | User identifier as seen by OpenClaw (Telegram numeric ID, Discord ID, etc.) |
| `aliases` | ❌ | Comma-separated alternative names for cross-user attribution |
| `groups` | ✅ | Comma-separated group slugs (must match `### <slug>` under `## Gruppi`) |
| `channel` | ❌ | Primary channel (informational) |
| `relazioni` | ❌ | Free-form relationships with other users (used in roster for name disambiguation) |
| `restrictions` | ❌ | Comma-separated permission overrides (e.g., `no_exec, no_system`) |
| `born` | ❌ | Birth date (used by recall for contextual info) |
| `### Profilo` | ✅ | Multi-line behavioral profile, injected only for the current sender |

> The **slug** (H2 heading, e.g. `## alice`) becomes the canonical name — used as `owner_id` in facts. The classifier resolves aliases automatically.

### Groups

| Field | Required | Description |
|-------|----------|-------------|
| `### <slug>` | ✅ | Group identifier (H3 under `## Gruppi`) |
| `permissions` | ✅ | Comma-separated base permissions for all group members |
| `description` | ❌ | Human-readable description |
| `scope` | ❌ | Semicolon-separated topic scopes for group-level facts |

> Group membership is declared on the **user side** (field `groups:`), not on the group. The plugin inverts the relationship to populate the `group_members` DB table.

**2. Auto-sync:** The plugin automatically parses `USERS.md` and syncs to the database on the first agent turn after gateway startup. No manual enrollment steps required.

**3. Bootstrapping initial knowledge (Optional):**

If you have legacy notes (`USER.md`, `MEMORY.md`, or a `memory/` folder) in your workspace, you can extract them into structured facts using the AI bootstrap command before starting the system for the first time. 
*Note: This command uses the gateway's LLM engine.*

Run the following command directly in the OpenClaw CLI or chat interface:
`/wiki-init`

This will parse the markdown, insert facts into the DB, generate embeddings, and move legacy files to `.memory-backup/`.

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
          "keepTurns": 6
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
| `keepTurns` | `6` | Conversation turns to keep (also used as classifier window) |
| `classifierModel` | `flash` | LLM model for classification |
| `dreamIntervalHours` | `6` | Hours between light dream cycles |
| `dreamRemTime` | `03:00` | Time for nightly deep dream (HH:MM) |
| `minMessageLength` | `10` | Min chars to classify a message |
| `maxMessageLength` | `2000` | Max chars sent to classifier |
| `promptPatchesFile` | *(none)* | Path to a JSON file with declarative system prompt patches (see [Prompt Patcher](#prompt-patcher)) |

> **Tip:** You can adjust the conversation history depth and classifier window directly from the OpenClaw CLI without editing the JSON file manually:
> ```bash
> openclaw config set plugins.entries.openclaw-memory-wiki-engine.config.keepTurns 8
> ```

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
| `/wiki-init` | Bootstrap legacy workspace files (MEMORY.md, USER.md, memory/) into facts |
| `/dream` | Trigger a manual dream cycle (`/dream rem` for deep) |
| `/memory-status` | Show memory statistics |
| `/focus <topic>` | Force a topic for the current session |
| `/wiki-ingest` | Process files from `raw/` into wiki pages or facts |
| `/wiki-lint` | Health check: stale pages, orphans, gaps |
| `/wiki-sync` | Incremental wiki update from recent facts |

## How it works

### Capture pipeline

1. Every user message is **archived** (raw transcript, always)
2. The **classifier** (Gemini Flash via direct REST call) analyzes the message:
   - Assigns 1-3 topics
   - Detects fact type (fact/bio/preference/rule/episode/plan/internal)
   - Flags tasks (routed to skills, not stored)
   - Handles cross-user attribution ("Bob doesn't like pesto" → attributed to Bob)
3. Memorable messages are saved as **captures** (pending promotion)

### Dream engine

- **Light dream** (every 6h): promotes captures to permanent facts, generates embeddings, checks supersedence
- **REM dream** (nightly at 03:00): deduplication (cosine > 0.85), confidence decay (>90 days unused), **Shadow Diff** (extracts human edits from Obsidian), **Wiki Compiler** (Semantic Merge of facts into prose with ACL tags), archive compression (>6 months)

### Recall (context injection)

Before each prompt, the plugin injects relevant context with 5 priority layers:

1. **Routing hints** — skill/action routing cues
2. **Wiki pages** — matching entity/concept pages
3. **Hybrid search** — BM25 + vector results from facts
4. **Session captures** — current session context

Total budget is ~1100 tokens (configurable), distributed across layers with graceful truncation.

### Prompt Patcher

The plugin supports **declarative system prompt modification** via an external JSON file. This allows removing or replacing sections of the OpenClaw system prompt without code changes.

Configure via `pluginConfig`:

```json
{
  "promptPatchesFile": "~/.openclaw/workspace/.openclaw/prompt-patches.json"
}
```

Patch file format:

```json
{
  "remove": [
    { "id": "self-update", "match": "## OpenClaw Self-Update", "type": "section" }
  ],
  "replace": [
    { "id": "my-edit", "target": "old text", "replacement": "new text" }
  ]
}
```

- `remove` (type `section`): removes from `## Heading` to the next `## ` or end-of-prompt
- `replace`: exact string substitution
- If `promptPatchesFile` is not set, no patches are applied

### Multi-user architecture (Block-Level ACL)

The engine is designed from the ground up for **multi-user** environments (families, teams, shared assistants). The knowledge base is a **unified, shared space**, but privacy is enforced at the **block level**. Every fact is tagged with an **owner**, which acts as its Access Control List (ACL):

| Owner type | Scope (Who can read) | Example | Injected `<auth>` tag |
|------------|-------|---------|---------|
| `global` | Visible to all users | "The WiFi password is ..." | None |
| `group` | Shared within a group + Sender | "We need detergent" (owner: `family`) | `<auth type="group" owner="family" sender="alice">` |
| `user` | Private to one person + Sender | "Alice does karate" (owner: `alice`) | `<auth type="user" owner="alice" sender="bob">` |

**Cross-user attribution** — when user A says *"Bob doesn't like pesto"*, the classifier attributes the fact to `bob`. The wiki compiler will write this fact into a shared document but protect it with `<auth type="user" owner="bob" sender="alice">`.

**Recall scoping & Regex Filtering** — during context injection, Sam loads the shared wiki file. Before passing it to the LLM, the `recall.ts` module uses a regex filter to **instantly redact** any `<auth>` block the current user is not authorized to see. An authorization succeeds if:
- They are the `sender_id`.
- They are the `owner` (for type `user`).
- They belong to the `owner` group (for type `group`).
Facts from other users are **never** leaked into someone else's prompt, effectively acting like a dynamically declassified document.

**Wiki pages (Topic-Driven)** — the dream engine auto-generates a unified wiki in a flat structure under `wiki/pages/`. Pages are generated per **Topic** (e.g., `ashnazg.md`, `dnd.md`), aggregating all facts that belong to that concept. The LLM compiler seamlessly merges public and restricted facts into narrative prose, injecting the necessary `<auth>` HTML tags for restricted paragraphs.

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production build
```

## Requirements

- Node.js ≥ 20
- OpenClaw ≥ 2026.4.0
- Ollama (mandatory, for vector search and dream consolidation)

## License

MIT
