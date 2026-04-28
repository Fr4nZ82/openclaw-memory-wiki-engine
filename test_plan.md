# Memory Wiki Engine — Test Plan Completo

> Sessione di test end-to-end sul miniPC remoto.
> Francesco = hands-on, Antigravity = orchestratore.

## Legenda Status

| Emoji | Significato |
|-------|------------|
| ⬜ | Da fare |
| 🔄 | In corso |
| ✅ | Superato |
| ❌ | Fallito |
| ⏭ | Saltato |

---

## Phase 0 — Pre-flight ✅

| # | Test | Come | Status |
|---|------|------|--------|
| 0.1 | Gateway running | `openclaw doctor` via SSH | ✅ |
| 0.2 | Plugin loaded | Log: `[Memory Wiki Engine] Activated` | ✅ |
| 0.3 | Compaction registered | Log: `Compaction provider registered` | ✅ |
| 0.4 | DB exists | `ls -la ~/.openclaw/wiki-engine/engine.db` | ✅ |
| 0.5 | Wiki dirs created | `ls -laR ~/.openclaw/wiki-engine/wiki/` — 4 entity pages, topic-index.json, `manual.md` rimossa | ✅ |
| 0.6 | Ollama status | Ollama sulla Torre (192.168.1.136:11434), il miniPC si connette via LAN | ✅ |

## Phase 1 — Enrollment ✅

| # | Test | Come | Status |
|---|------|------|--------|
| 1.1 | Enroll users+groups | `npx tsx scripts/enroll.ts scripts/users.json` → "✅ Enrolled 4 user(s), 3 group(s), 5 membership(s)" | ✅ |
| 1.2 | Dump verifica | `npx tsx scripts/enroll.ts --dump` → JSON completo con users+groups | ✅ |
| 1.3 | Idempotency | Re-run enroll su dati esistenti — nessun errore, stessi conteggi | ✅ |
| 1.4 | Verify 4 users | Frodo/7776007798, Galadriel/6994940390, Gollum/tesssoro-daniel, Bilbo/8620492026 | ✅ |
| 1.5 | Verify 3 groups | famiglia (3 members), admin (1 member), amici (1 member) | ✅ |

## Phase 2 — Init (bootstrap) ✅

| # | Test | Come | Status |
|---|------|------|--------|
| 2.1 | Dry run | `npx tsx scripts/init.ts --dry-run` — 26 fatti estratti, tutti in italiano | ✅ |
| 2.2 | Real init | `npx tsx scripts/init.ts` — 34 fatti inseriti nel DB (Gemini ha prodotto un set diverso dal dry-run, normale variabilità LLM) | ✅ |
| 2.3 | Facts extracted | 34 fatti `sender_id='init'` + 4 fatti live pre-esistenti = 38 attivi totali | ✅ |
| 2.4 | MEMORY.md backup | `~/.openclaw/workspace/.memory-backup/MEMORY.md` — backuppato e rimosso dal workspace | ✅ |
| 2.5 | Language compliance | Istruzione "Write facts in the SAME LANGUAGE" nel prompt init → tutti i 34 fatti in italiano | ✅ |
| 2.6 | Owner distribution | gollum:13, frodo:9, famiglia:7, galadriel:5, bilbo:2, global:1, admin:1 | ✅ |
| 2.7 | Embeddings | 37 embedding generati via Torre (192.168.1.136:11434) con nomic-embed-text | ✅ |

## Phase 3 — Live Capture (Classifier + Archive) ✅

> Francesco invia messaggi su Telegram a Sam.

| # | Test | Messaggio | Expected | Status |
|---|------|-----------|----------|--------|
| 3.1 | Fact memorabile | "A Daniel piace il sushi... tantissimo!" | is_memorable=true, owner=gollum | ✅ |
| 3.2 | Preferenza | "Anche il mac Donalds gli piace molto, ci vuole sempre andare" | is_memorable=true, fact_type=preference, owner=gollum | ✅ |
| 3.3 | Task (skip) | "Ricordami di comprare il latte domani" | is_task=true, non catturato | ✅ |
| 3.4 | Saluto (skip) | "Ciao Sam, come stai?" / "Ciao" | is_memorable=false, topics=["saluti"] | ✅ |
| 3.5 | Episodio | "ieri ho mangiato 2 pizze" | is_memorable=true, fact_type=episode, owner=frodo | ✅ |
| 3.6 | Conferma episodio | "Infatti mi sentivo pieno e avevo sonno" | is_memorable=true, catturato | ✅ |
| 3.7 | Regola | "Daniel non può usare il PC per più di 2 ore al giorno" | fact_type=rule, owner=gollum | ✅ |
| 3.8 | Cross-user | "A Jenny piace il tiramisù, ma solo senza glutine!" | owner=galadriel (resolved from alias) | ✅ |
| 3.9a | Fatto gruppo (1st) | "Serve comprare il detersivo per la lavastoviglie" | classifier → is_task=true, owner=famiglia ✅ (corretto skip: è un task) | ✅ |
| 3.9b | Fatto gruppo (retry) | "A casa nostra si mangia sempre alle 20" | owner=famiglia ✅ (dopo fix scope, commit `19a4c18`) | ✅ |
| 3.10 | Archive check | Query: `SELECT COUNT(*) FROM session_archive` | ≥ 7 messages | ✅ |
| 3.11 | Captures check | Query: `SELECT * FROM session_captures WHERE promoted=0` | ≥ 2 captures | ✅ |

## Phase 4 — Recall (Context Injection) ✅

| # | Test | Come | Status |
|---|------|------|--------|
| 4.1 | Recall log | Dopo messaggio, cercare `[Recall]` nei log | ✅ |
| 4.2 | Token budget | Log mostra token count ≤ 1100 | ✅ (321-325 tokens) |
| 4.3 | Session captures inject | Log: `capturesFound > 0` | ✅ (captures: 1) |
| 4.4 | Sender resolution | Log: `resolveCanonicalId: sender=X → frodo` | ✅ |
| 4.5 | Facts inject | Log: `factsMatched > 0` | ✅ (facts: 5) |
| 4.6 | prependContext return | apiaudit.txt mostra contesto iniettato via return object | ✅ (ADR-013) |
| 4.7 | Stateless sender extract | sender estratto da event.messages, non da cache globale | ✅ (ADR-013) |
| 4.8 | Query = testo utente reale | Log: `query="ieri ho mangiato 2 pizze"` (non wrapper metadata) | ✅ |
| 4.9 | Multi-part content parsing | Content array processato part-by-part, non joinato | ✅ |

## Phase 5 — Dream Light ✅

| # | Test | Come | Status |
|---|------|------|--------|
| 5.1 | Trigger dream | Comando `/dream` su Telegram → "Dream light complete" | ✅ |
| 5.2 | Captures promoted | 0 captures processate (corretto: DB appena pulito, nessuna capture pendente) | ✅ |
| 5.3 | Facts created | 38 fatti attivi nel DB (34 init + 4 live) | ✅ |
| 5.4 | Embeddings | 37/38 fatti con embedding (1 pre-esistente già aveva embedding) | ✅ |
| 5.5 | Response text | Report mostra captures:0, facts:0, superseded:0 — corretto per DB pulito | ✅ |

## Phase 6 — Dream REM ✅

| # | Test | Come | Status |
|---|------|------|--------|
| 6.1 | Trigger REM | Comando `/dream rem` su Telegram → dedup:5, wiki:5 | ✅ |
| 6.2 | Wiki pages | 5 entity pages: frodo.md, gollum.md, galadriel.md, bilbo.md, famiglia.md — tutte in italiano | ✅ |
| 6.3 | Topic index | `topic-index.json` presente in `wiki/_meta/` | ✅ |
| 6.4 | MEMORY.md | `wiki-engine/MEMORY.md` rigenerato con regole per frodo, galadriel, global, gollum — in italiano | ✅ |
| 6.5 | Dream report | Report mostrato direttamente nella risposta Telegram | ✅ |

## Phase 7 — Tools ✅

> Francesco chiede a Sam di usare i tool.

| # | Test | Messaggio/Azione | Expected | Status |
|---|------|-----------------|----------|--------|
| 7.1 | memory_search (recall) | "Quando è il compleanno di Daniel?" | Sam risponde "31 ottobre 2017" dal DB | ✅ |
| 7.2 | remember | "Ricordati che la password del WiFi casa è caccasecca" | owner=frodo ✅ (no "manual"). Classifier cattura anche come owner=famiglia | ✅ |
| 7.3 | archive_search | "Cerca nei tuoi ricordi cosa ho detto sul cibo ieri" | Sam usa memory_search + archive_search, trova pizza/sushi/McDonald's | ✅ |
| 7.4 | wiki_status | "Mostrami lo status del wiki della memoria" | 6 pages, 4 entities, 1 group, 1 concept | ✅ |

## Phase 8 — Wiki Operations ✅

| # | Test | Come | Status |
|---|------|------|--------|
| 8.1 | /wiki-lint | Comando su Telegram | Report ok: 6 pages, 0 stale, 0 orphan, topic index ✅ | ✅ |
| 8.2 | /wiki-sync | Comando su Telegram | 3 pages updated (admin, bilbo, famiglia), topic-index regenerated | ✅ |
| 8.3 | /wiki-ingest | File in raw/ + `/wiki_ingest` | Files processed: 1, Pages created: 1 | ✅ |

## Phase 9 — Supersedence ✅

| # | Test | Messaggio | Expected | Status |
|---|------|-----------|----------|--------|
| 9.1 | Fatto + dream | "Il mio colore preferito è il verde" + `/dream` | Catturato e promosso | ✅ |
| 9.2 | Dual-capture supersedence | Classifier + remember catturano lo stesso fatto | Dream supersede il duplicato, 1 attivo 1 inattivo | ✅ |
| 9.3 | Verifica DB | `SELECT ... FROM facts WHERE text LIKE '%colore%'` | `f_moihuhxr` (classifier) superseded → `f_moihui78` (remember) attivo | ✅ |
| 9.4 | Supersedence cross-user | Tiramisù Galadriel: dual capture superseded | 1 attivo, 1 superseded, owner=galadriel in entrambi | ✅ |
| 9.5 | Conteggio totale | 9 fatti superseded nel DB | Init duplicates (7) + dual captures (2) | ✅ |

## Phase 10 — /memory-status ✅

| # | Test | Come | Status |
|---|------|------|--------|
| 10.1 | Status command | `/memory_status` su Telegram | Report: Active:42, Superseded:9, Pending:0, Archived:72 | ✅ |
| 10.2 | Active facts | 42 > 0 | ✅ |
| 10.3 | Archived messages | 72 > 0 | ✅ |

---

## Bugs trovati e fixati

### Sessione 2026-04-26/27

#### BUG-1: `maxOutputTokens: 512` → JSON troncato ❌→✅

**Root cause**: Gemini Flash tronca la risposta a metà JSON quando `maxOutputTokens` è troppo basso. Il parser riceve JSON invalido (es. `{ "topics": ["`), fallisce silenziosamente e restituisce il fallback `is_memorable: false, topics: ["general"]`.

**Fix**: `maxOutputTokens: 16384` in `classifier.ts` → `callLlmTask()`.
**Commit**: `884720a`

> [!CAUTION]
> Pattern ricorrente! Stesso bug in Supermemory `semantic-runtime.ts` (2048→8192). Documentato in `.agents/rules/recurring-mistakes.md` §3.

#### BUG-2: `before_prompt_build` — sender/query sempre `unknown` ❌→✅→✅✅

**Root cause**: L'hook `before_prompt_build` ha schema `{prompt, messages}` senza `from` né `metadata`. Il codice cercava `event.from` che non esiste → `sender=unknown`.

**Fix v1** (commit `e67de6e`, `a469807`): Cache di `senderId`, `sessionId`, `messageText` dal `message_received` precedente.

**Fix v2 — definitivo** (commit `231a8fd`, ADR-013): Eliminata completamente la cache globale cross-hook. Sender e session estratti direttamente da `event.messages[].metadata` e `event.sessionKey` dentro `before_prompt_build`. Zero stato condiviso tra hook.

> [!NOTE]
> La Fix v1 (cache globale) causava il BUG-5 (phantom turns). ADR-013 risolve entrambi i problemi contemporaneamente.

#### BUG-3: `userQuery` conteneva metadata di sistema ❌→✅

**Root cause**: L'array `event.messages` nel `before_prompt_build` contiene messaggi con metadata di sistema prepend (es. `"Conversation info (untrusted metadata): { json...}"`) che inquinavano la ricerca BM25/vector.

**Fix v1** (commit `a469807`): Usare il testo cachato dal `message_received` invece di estrarlo da `messages`.

**Fix v2 — definitivo** (commit `231a8fd`, ADR-013): La query viene estratta dal loop su `event.messages` filtrando per `msg.role === "user"` e leggendo `msg.content` (testo puro o array di content parts). I messaggi di sistema non hanno `role: "user"` e vengono automaticamente ignorati.

#### BUG-4: `session=unknown` per tutte le catture ❌→✅

**Root cause**: `event.metadata.sessionKey` e `event.metadata.channelId` sono `undefined` su Telegram. Fallback era `"unknown"`.

**Fix**: Fallback a `event.from` (es. `telegram:7776007798`) che identifica univocamente il canale utente.
**Commit**: `a469807`

### Sessione 2026-04-27 (Refactoring ADR-013)

#### BUG-5: Phantom turns da heartbeat con sender stale ❌→✅

**Root cause**: Le variabili globali `lastReceivedSenderId` / `lastReceivedSessionId` (introdotte per BUG-2 fix v1) mantenevano i dati dell'ultimo messaggio umano reale. Quando l'heartbeat/cron attivava un turno autonomo, `before_prompt_build` usava quei dati stale iniettando contesto per un utente che non stava parlando.

**Fix**: ADR-013 — eliminazione completa delle variabili globali cross-hook. Ogni hook è stateless e autosufficiente.
**Commit**: `231a8fd`

#### BUG-6: `event.addSystemContext()` — pattern legacy ❌→✅

**Root cause**: `event.addSystemContext()` è una mutazione in-place dell'evento, pattern legacy non usato dai plugin enterprise (Engram usa `return { prependContext }`, Claude-Mem usa `return { appendSystemContext }`). Espone a collisioni multi-plugin.

**Fix**: ADR-013 — `return { prependContext: recallCtx.systemContext }`.
**Commit**: `231a8fd`

### Sessione 2026-04-27/28 (Envelope Parser)

#### BUG-7: Envelope detection solo per "Conversation info" prefix ❌→✅

**Root cause**: Il parser usava `startsWith("Conversation info (untrusted metadata):")` come unico match. Ma l'ultimo messaggio nel `before_prompt_build` usa il formato `"Sender (untrusted metadata):"`. Il messaggio reale veniva scartato.

**Fix**: Generalizzato il match a qualsiasi contenuto con `"(untrusted metadata):"` + `` ```json ``.
**Commit**: `2dc0614`

#### BUG-8: Multi-part content array joinata in stringa unica ❌→✅

**Root cause**: OpenClaw invia `content: [{type:"text", text:"Conversation info..."}, ...]` — un array multi-part. Il codice faceva `.join(" ")` distruggendo la separazione envelope/testo.

**Fix**: Processamento indipendente di ogni content part: envelope → sender, non-envelope → query.
**Commit**: `da1af6e`

#### BUG-9: Closing fence detection con `indexOf("\n\`\`\`\n")` falliva ❌→✅

**Root cause**: Il parser cercava `\n\`\`\`\n` esatta per il closing fence. Il formato reale non matchava → `userText=""` → skip di tutti i messaggi.

**Fix**: `raw.lastIndexOf("\`\`\`")` per trovare l'ultimo triple backtick.
**Commit**: `2e73263`

### Sessione 2026-04-28

#### BUG-10: Tool `remember` hardcodava `senderId="manual"` ❌→✅

**Root cause**: Il tool `remember` (registrato via `api.registerTool()`) non ha accesso al contesto della conversazione (`event`). Il codice hardcodava `senderId = "manual"` e usava lo stesso valore come `owner_id`, creando fatti orfani non associati a nessun utente enrolled.

**Impatto**: Tutti i fatti salvati tramite tool `remember` finivano con `owner_id: "manual"`, invisibili nel recall (che filtra per owner). 14 captures affette, 1 fatto promosso a `facts`.

**Fix**:
1. `lastResolvedSender` (module-level) settato nel `before_prompt_build` con il sender corrente
2. Il tool `remember` usa `lastResolvedSender` + `resolveCanonicalId()` per risolvere l'owner corretto
3. Aggiunto parametro opzionale `owner` per fatti cross-user (es. "Jenny ama i libri" → owner=galadriel)
4. `session_id` cambiato da `"manual"` a `"remember-{senderId}"` per tracciabilità

> [!NOTE]
> La variabile `lastResolvedSender` è safe perché OpenClaw processa un turno alla volta per istanza gateway — il sender risolto in `before_prompt_build` è lo stesso i cui tool calls eseguono subito dopo.

---

## Rimediazione entità fantasma `manual` ✅

Completata 2026-04-27: 12 fatti con `owner_id="manual"` eliminati, pagina `entities/manual.md` rimossa, 23 fatti attivi rimangono con owner corretto.

> ⚠️ **Root cause** identificata in BUG-10. Con il fix applicato, il tool `remember` non creerà più fatti con owner "manual".

## Sanitizzazione DB e re-bootstrap ✅

Completata 2026-04-28:

1. **Pulizia chirurgica**: eliminati tutti i record `sender_id='init'` (20) e `sender_id='manual'` (1 fatto + 14 captures)
2. **Re-bootstrap italiano**: `npx tsx scripts/init.ts` con `bootstrap_facts_summarized.md` curato manualmente → 34 fatti in italiano
3. **Embedding**: script `fix_embeddings.ts` ha generato 37 embedding (34 init + 3 live senza embedding) via Torre
4. **Stato finale DB**: 38 fatti attivi, 0 record "manual", tutti con owner canonico corretto

#### BUG-11: `init.ts` cercava `ollamaUrl` ma config usa `embeddingUrl` ❌→✅

**Root cause**: `resolveEmbeddingUrl()` in `scripts/init.ts` leggeva solo `pluginConfig.ollamaUrl`, ma `openclaw.json` definisce la chiave come `embeddingUrl`. Fallback a `localhost:11434` → connessione rifiutata (Ollama è sulla Torre, non sul miniPC).

**Fix**: Aggiunto check prioritario per `pluginConfig.embeddingUrl` prima di `ollamaUrl`.
**Commit**: `d736a56`

#### BUG-12: Classifier prompt senza group scope → attribuzione gruppo sbagliata ❌→✅

**Root cause**: Il prompt del classifier mostrava i gruppi dell'utente come `- famiglia (Famiglia)` senza la colonna `scope`. Senza scope, Gemini non sa distinguere quale gruppo possiede un fatto ("regole della casa" → famiglia o admin?). Test 3.9b ha fallito con `owner=admin` per un fatto domestico.

**Fix**: 
1. Aggiunto `scope` a `UserGroupInfo` interface
2. Query `getUserGroups()` ora include `g.scope`
3. Il prompt mostra: `- famiglia (Famiglia)\n  Scope: Regole della casa; Spesa e lista; ...`

**Commit**: `19a4c18`

#### BUG-13: `session=unknown` nel `before_prompt_build` su Telegram ❌→✅

**Root cause**: L'hook `before_prompt_build` riceve `event = {prompt, messages}` senza `event.from`, `event.sessionKey` né `event.metadata`. Il fallback per `sessionId` era sempre `"unknown"`. Nel `message_received` funzionava perché usa `event.from` (es. `telegram:7776007798`).

**Impatto**: Il recall usava `session=unknown` per le query sulle session_captures → nessun match session-scoped.

**Fix**: Fallback a `telegram:${extractedSenderId}` (sender estratto dall'envelope metadata dei messaggi).
**Commit**: `79f81cf`

#### BUG-14: `memory_search` tool con `sender=unknown` → recall non scoped ❌→✅

**Root cause**: Il tool `memory_search` usava `extractSenderId(undefined)` che restituiva sempre `"unknown"`. Il recall non filtrava per utente, restituendo fatti di tutti.

**Fix**: Usa `lastResolvedSender` (settato in `before_prompt_build`), stesso pattern del tool `remember` (BUG-10).
**Commit**: `ffb53fa`

#### BUG-15: Classifier gira su slash commands → spreco API ❌→✅

**Root cause**: I messaggi `/dream`, `/wiki-lint`, `/wiki-sync` passavano per il classifier Gemini nel hook `message_received`. Ogni comando sprecava una chiamata API.

**Fix**: Skip early in `message_received` per messaggi che iniziano con `/`.
**Commit**: `238955c`

#### BUG-16: Tool `remember` crea duplicati del classifier → supersedence inutile ❌→✅

**Root cause**: Il tool `remember` (registrato da noi, NON richiesto dall'SDK) salvava in `session_captures` senza classificare. La pipeline automatica (classifier) catturava lo stesso messaggio con qualità superiore (topics Gemini, group scope, fact_type corretto). Il dream doveva poi supersedere i duplicati.

**Fix**: Tool `remember` rimosso. Solo la pipeline classifier cattura fatti.
**Commit**: `5320224`

## Dream REM manuale ✅

Triggered via Telegram `/dream rem` il 2026-04-28:

| Metrica | Risultato |
|---|---|
| Captures processed | 0 (corretto: nessuna capture pendente) |
| De-duplicated | 5 (fatti simili consolidati) |
| Wiki pages updated | 5 (frodo, gollum, galadriel, bilbo, famiglia) |
| MEMORY.md | Rigenerato in italiano con regole operative |
| Wiki entities | Tutte in italiano con frontmatter YAML |

## Recall live ✅

Testato 2026-04-28 via Telegram:

| Query | Risposta Sam | Corretto? |
|---|---|---|
| "Quando è il compleanno di Daniel?" | "Il compleanno di Daniel è il 31 ottobre [...] del 2017!" | ✅ |

---

## Infrastruttura debug deployata

| Componente | Dettaglio |
|---|---|
| Modulo | `src/debug.ts` — `dbg(scope)` pattern |
| File log | `/tmp/mwe-debug.log` (rotazione ad ogni restart) |
| Console | Tutto appare sul Palantír con prefix `[MWE:scope]` |
| Toggle | `debug: true` nella config plugin, oppure `MWE_DEBUG=1` env var |
| Scopes | `hooks`, `classifier`, `capture`, `recall` |
| Diagnostica msg | Dump struttura content (string vs array, ogni part) per debug rapido |
| Audit | `~/.openclaw/apiaudit.txt` — registra tutte le chiamate LLM incluso il contesto iniettato |

---

## Comandi SSH utili per query DB

```bash
# Path al DB
DB=~/.openclaw/wiki-engine/engine.db

# Conteggi
sqlite3 $DB "SELECT COUNT(*) FROM facts WHERE is_active=1;"
sqlite3 $DB "SELECT COUNT(*) FROM session_captures WHERE promoted=0;"
sqlite3 $DB "SELECT COUNT(*) FROM session_archive;"
sqlite3 $DB "SELECT COUNT(*) FROM users;"

# Dettaglio fatti attivi
sqlite3 $DB "SELECT id, text, fact_type, owner_type, owner_id, confidence FROM facts WHERE is_active=1;"

# Captures pendenti
sqlite3 $DB "SELECT id, fact_text, topics, owner_id, fact_type FROM session_captures WHERE promoted=0;"

# Dump users
sqlite3 $DB "SELECT sender_id, names FROM users;"

# Ultimi messaggi archive
sqlite3 $DB "SELECT sender_name, role, substr(message_text,1,60), timestamp FROM session_archive ORDER BY id DESC LIMIT 10;"

# Debug log (se abilitato)
cat ~/.openclaw/wiki-engine/mwe-debug.log

# Audit log — contesto iniettato
grep -i "prependContext\|Capture\|Recall" ~/.openclaw/apiaudit.txt | tail -10
```
