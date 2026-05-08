import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import type { PluginConfig } from "./config";

import { callLlmTask } from "./classifier";

/**
 * Ensures the shadow directory exists.
 */
function getShadowPath(config: PluginConfig, relativePath: string): string {
  const shadowBase = path.join(config.wikiPath, ".shadow");
  return path.join(shadowBase, relativePath);
}

/**
 * Phase 1: Shadow Diff
 * Scans the wiki for human edits (mtime > shadow mtime).
 * Extracts delta facts using Gemini and updates the DB.
 */
// Helper per parsi sicuro
function parseJsonFromLlm(response: any, component: string, logger: any): any {
  if (typeof response !== "string") return response;

  let cleaned = response.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    logger.error(`[Wiki Compiler] JSON parse failed in ${component}! Raw response was:\n---\n${response}\n---\n`);
    throw err;
  }
}

export async function syncHumanEdits(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  logger: any
): Promise<number> {
  let humanEditsFound = 0;
  const shadowBase = path.join(config.wikiPath, ".shadow");
  if (!fs.existsSync(shadowBase)) fs.mkdirSync(shadowBase, { recursive: true });

  const subDirs = ["pages"];

  for (const dir of subDirs) {
    const dirPath = path.join(config.wikiPath, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith(".md"));

    for (const file of files) {
      const relativePath = path.join(dir, file);
      const wikiFilePath = path.join(config.wikiPath, relativePath);
      const shadowFilePath = getShadowPath(config, relativePath);

      // Check for human modification
      if (fs.existsSync(shadowFilePath)) {
        const wikiStat = fs.statSync(wikiFilePath);
        const shadowStat = fs.statSync(shadowFilePath);

        // If wiki file is strictly newer than shadow copy by > 2 seconds
        if (wikiStat.mtimeMs > shadowStat.mtimeMs + 2000) {
          logger.info(`[Wiki Compiler] Detected human edit on ${relativePath}`);
          humanEditsFound++;

          const wikiContent = fs.readFileSync(wikiFilePath, "utf-8");
          const shadowContent = fs.readFileSync(shadowFilePath, "utf-8");

          await extractDelta(api, db, config, wikiContent, shadowContent, relativePath, logger);

          // Update shadow to match the newly ingested human edits
          fs.writeFileSync(shadowFilePath, wikiContent, "utf-8");
        }
      }
    }
  }

  return humanEditsFound;
}

/**
 * Calls LLM to extract newly added facts or contradicted facts from human edits.
 */
async function extractDelta(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  newContent: string,
  oldContent: string,
  relativePath: string,
  logger: any
) {
  const prompt = `You are a diff analyzer. Analyze the old and new markdown content of a wiki page.
Identify ANY newly added facts or rules by the human user.
Return a JSON array of objects representing NEW or CHANGED facts.
Format:
[{"text": "...", "fact_type": "fact|rule|preference", "topics": ["..."], "owner_id": "..."}]

Old Content:
"""
${oldContent.substring(0, 4000)}
"""

New Content:
"""
${newContent.substring(0, 4000)}
"""`;

  try {
    if (config.debug) logger.debug(`[Wiki Compiler] Extracting delta from ${relativePath} with LLM...`);
    let response = await callLlmTask(api, prompt, "shadow-diff", 120000);

    const facts = parseJsonFromLlm(response, "extractDelta", logger);
    if (Array.isArray(facts) && facts.length > 0) {
      const { topicsToJson } = await import("./utils");

      for (const fact of facts) {
        if (!fact.text) continue;

        // Save as capture so the Dream Engine will natively handle supersedence and embedding
        db.prepare(
          `INSERT INTO session_captures
            (session_id, message_text, fact_text, topics, sender_id,
             owner_type, owner_id, fact_type, is_internal, captured_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))`
        ).run(
          "shadow-diff",
          `diff:${relativePath}`,
          fact.text,
          topicsToJson(fact.topics || ["wiki_edit"]),
          "system",
          fact.owner_type || "global",
          fact.owner_id || "system",
          fact.fact_type || "fact"
        );
      }
      logger.info(`[Wiki Compiler] Extracted ${facts.length} facts from ${relativePath} edits`);
      if (config.debug) logger.debug(`[Wiki Compiler] Successfully saved ${facts.length} new captures for the Dream Engine`);
    }
  } catch (error) {
    logger.error(`[Wiki Compiler] Delta extraction failed for ${relativePath}. Aborting: ${error}`);
    throw error;
  }
}

/**
 * Phase 3 & 4: Semantic Merge & Wikilink Resolution
 */
export async function semanticMergePage(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  targetEntity: { topic: string; title: string },
  facts: any[],
  logger: any
): Promise<boolean> {
  const fileName = `${targetEntity.topic.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.md`;
  const relativePath = path.join("pages", fileName);
  const filePath = path.join(config.wikiPath, relativePath);
  const shadowFilePath = getShadowPath(config, relativePath);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.mkdirSync(path.dirname(shadowFilePath), { recursive: true });

  const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  const now = new Date().toISOString().split("T")[0];
  let createdDate = now;
  if (existingContent) {
    const match = existingContent.match(/^created:\s*(.+)$/m);
    if (match) {
      createdDate = match[1].trim();
    } else {
      try { createdDate = fs.statSync(filePath).birthtime.toISOString().split("T")[0]; } catch (e) { }
    }
  }

  // Extract tags, sources, and check confidence
  const tagsSet = new Set<string>([targetEntity.topic]);
  const sourcesSet = new Set<string>();
  let hasMediumConfidence = false;

  const factsList = facts.map(f => {
    try {
      const ts = JSON.parse(f.topics);
      if (Array.isArray(ts)) ts.forEach((t: string) => tagsSet.add(t.toLowerCase()));
    } catch { }
    if (f.sender_id) sourcesSet.add(`sender:${f.sender_id}`);
    if (f.confidence < 0.8) hasMediumConfidence = true;

    // Build ACL tag for prompt
    let aclStr = "";
    if (f.owner_type && f.owner_type !== "global") {
      aclStr = ` [ACL: type="${f.owner_type}" owner="${f.owner_id}" sender="${f.sender_id}"]`;
    }
    return `- [${f.fact_type.toUpperCase()}] ${f.text}${aclStr}`;
  }).join("\n");

  let mergedBody = "";
  let description = targetEntity.title;
  let aliases: string[] = [];

  try {
    // Build known slugs dictionary from pages folder
    const knownSlugs: string[] = [];
    try {
      const files = fs.readdirSync(path.join(config.wikiPath, "pages"));
      knownSlugs.push(...files.filter(f => f.endsWith(".md")).map(f => f.replace(".md", "")));
    } catch { }

    let userAliasesText = "";
    try {
      const users = db.prepare("SELECT names FROM users").all() as Array<{ names: string }>;
      const aliasesMap: string[] = [];
      for (const u of users) {
        const names = JSON.parse(u.names) as string[];
        if (names.length > 0) {
          const canonical = names[0];
          const canonicalSlug = canonical.toLowerCase().replace(/[^a-z0-9]+/g, "_");
          const otherNames = names.slice(1);
          if (otherNames.length > 0) {
            aliasesMap.push(`- Canonical slug: ${canonicalSlug} (Aliases: ${otherNames.join(", ")}). Replace the alias with the canonical name and use [[${canonicalSlug}]]`);
          } else {
            aliasesMap.push(`- Canonical slug: ${canonicalSlug}`);
          }
          if (!knownSlugs.includes(canonicalSlug)) knownSlugs.push(canonicalSlug);
        }
      }
      if (aliasesMap.length > 0) {
        userAliasesText = "\nKnown Users & Aliases (Normalize all aliases to their canonical name when linking):\n" + aliasesMap.join("\n");
      }
    } catch (e) {
      logger.warn(`[Wiki Compiler] Could not load user aliases: ${e}`);
    }

    const prompt = `Rewrite the following wiki page by merging the new facts.
DO NOT use bullet point lists if possible. Write a cohesive, narrative prose describing the entity/concept.
Insert Obsidian-compatible [[wikilinks]] for known concepts and entities naturally in the text.
If old facts are contradicted by new ones, update the narrative.
If a known entity is referred to by an alias, replace the alias with the canonical name using [[canonical_slug]].

CRITICAL LANGUAGE INSTRUCTION:
Write ALL wiki content in Italian (italiano). Title, description, body, and aliases must all be in Italian.

CRITICAL DEDUPLICATION INSTRUCTION:
If a concept or fact is already well-covered in a dedicated page (check the known slugs list), do NOT repeat it in full.
Instead, write a brief mention with a [[wikilink]] to the authoritative page.
Example: instead of re-explaining a person's work schedule in a concept page, write:
"[[frodo]] segue orari di lavoro strutturati (vedi [[frodo]])."
Full detail belongs on the most specific page; other pages should reference it briefly.

CRITICAL CHRONOLOGY INSTRUCTION:
Use specific dated episodes or future events ONLY as evidence to deduce skills, habits, roles, or relationships (e.g., "Tizen developer"). Summarize events in the past tense to provide historical context, but DO NOT turn the wiki into an appointment calendar. Do not include future dates or exact operational appointments in the final narrative.

CRITICAL ACL INSTRUCTION:
Some facts have [ACL: type="..." owner="..." sender="..."] tags.
You MUST wrap the corresponding information in the generated text with HTML tags like this:
<wikiauth type="user" owner="gollum" sender="frodo">Il testo riservato</wikiauth>
Public facts (without ACL tags) must remain plain text.

Return a JSON object with this exact structure:
{
  "mergedBody": "The full markdown text with <wikiauth> tags and [[wikilinks]]",
  "description": "A 1-2 sentence short summary of the page",
  "aliases": ["Alternative", "Names", "For", "This", "Topic"]
}

IMPORTANT: Ensure the JSON is strictly valid. Since \`mergedBody\` contains a long markdown text, you MUST properly escape all double quotes (\\") and newlines (\\\\n) inside strings.

Known slugs for wikilinks:
${knownSlugs.length > 0 ? knownSlugs.join(", ") : "None yet."}${userAliasesText}

Current Text:
"""
${existingContent.replace(/^---[\s\S]*?---\s*/, "")}
"""

Facts to include/merge:
"""
${factsList}
"""`;

    let attempts = 0;
    const maxAttempts = 2;
    while (attempts < maxAttempts) {
      try {
        attempts++;
        if (config.debug) logger.debug(`[Wiki Compiler] Requesting semantic merge for ${targetEntity.title} from LLM (Attempt ${attempts}/${maxAttempts})...`);
        const response = await callLlmTask(api, prompt, "wiki-merge", 120000);

        const parsed = parseJsonFromLlm(response, `semanticMergePage(${relativePath})`, logger);
        if (parsed.mergedBody) mergedBody = parsed.mergedBody.replace(/\\n/g, "\n");
        if (parsed.description) description = parsed.description;
        if (Array.isArray(parsed.aliases)) aliases = parsed.aliases;
        break; // Success
      } catch (e) {
        if (attempts >= maxAttempts) {
          logger.error(`[Wiki Compiler] LLM failed for ${relativePath} after ${maxAttempts} attempts. Aborting compilation: ${e}`);
          throw e;
        } else {
          logger.warn(`[Wiki Compiler] LLM failed for ${relativePath} (Attempt ${attempts}/${maxAttempts}). Retrying... Error: ${e}`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
  } catch (e) {
    logger.error(`[Wiki Compiler] Directory read failed: ${e}`);
    throw e;
  }

  // Strict enforcement: LLM must succeed
  if (!mergedBody) {
    throw new Error(`[Wiki Compiler] LLM failed to return a valid mergedBody for ${relativePath}`);
  }

  if (config.debug) logger.debug(`[Wiki Compiler] Generating frontmatter for ${targetEntity.title}`);

  // Generate Obsidian YAML Frontmatter
  const tagsYaml = Array.from(tagsSet).map(t => `  - ${t.replace(/\s+/g, "_")}`).join("\n");
  const aliasesYaml = aliases.length > 0 ? "\n" + aliases.map(a => `  - "${a}"`).join("\n") : " []";
  const sourcesYaml = Array.from(sourcesSet).map(s => `  - "${s}"`).join("\n");

  const content = [
    "---",
    `title: "${targetEntity.title}"`,
    `description: "${description.replace(/"/g, "'")}"`,
    `created: ${createdDate}`,
    `updated: ${now}`,
    `aliases:${aliasesYaml}`,
    `tags:\n${tagsYaml}`,
    `confidence: ${hasMediumConfidence ? "medium" : "high"}`,
    `sources:\n${sourcesYaml}`,
    "---",
    "",
    mergedBody.trim(),
    ""
  ].join("\n");

  if (existingContent !== content) {
    fs.writeFileSync(filePath, content, "utf-8");
    // Update shadow copy too
    fs.writeFileSync(shadowFilePath, content, "utf-8");
    logger.info(`[Wiki Compiler] ${relativePath} semantically merged`);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Stadio 3: Il Cronista (Gemini Pro — leaf con fatti) + Hub Writer (Flash)
// ---------------------------------------------------------------------------

import type { PagePlan, CompilationPlan } from "./wiki-planner";

const PRO_MODEL = "gemini-3.1-pro-preview";
const FLASH_MODEL = "gemini-3-flash-preview";

/**
 * Compila una pagina della wiki. Dispatcher che sceglie:
 *   - Hub Writer (Flash) se la pagina è un hub (concept_hub o group_theme con 0 fatti propri)
 *   - Cronista (Pro) se la pagina è un leaf con fatti
 */
export async function compilePage(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  plan: CompilationPlan,
  slug: string,
  logger: any
): Promise<boolean> {
  const pagePlan = plan.pages[slug];
  if (!pagePlan) {
    logger.warn(`[Compiler] No plan found for page "${slug}", skipping`);
    return false;
  }

  // Hub: 0 primary facts AND has childLeaves → Hub Writer
  const isHub =
    pagePlan.primaryFacts.length === 0 &&
    pagePlan.childLeaves.length > 0 &&
    (pagePlan.pageType === "concept_hub" || pagePlan.pageType === "group_theme");

  if (isHub) {
    return await compileHubPage(api, db, config, plan, slug, logger);
  }
  return await compileLeafPage(api, db, config, plan, slug, logger);
}

/**
 * Hub Writer — narrazione coesa che cita ogni leaf con [[wikilink]].
 * Usa Flash (non Pro): è un task narrativo su pochi item, non analitico.
 * Non riceve fatti, solo titoli + description dei leaf figli.
 */
async function compileHubPage(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  plan: CompilationPlan,
  slug: string,
  logger: any
): Promise<boolean> {
  const pagePlan = plan.pages[slug];
  const fileName = `${slug}.md`;
  const relativePath = path.join("pages", fileName);
  const filePath = path.join(config.wikiPath, relativePath);
  const shadowFilePath = getShadowPath(config, relativePath);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.mkdirSync(path.dirname(shadowFilePath), { recursive: true });

  const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  const now = new Date().toISOString().split("T")[0];
  let createdDate = now;
  if (existingContent) {
    const match = existingContent.match(/^created:\s*(.+)$/m);
    if (match) createdDate = match[1].trim();
  }

  const childrenDesc = pagePlan.childLeaves
    .map(s => {
      const p = plan.pages[s];
      if (!p) return null;
      return `- [[${s}]] (${p.pageType}) — ${p.description || p.title}`;
    })
    .filter(Boolean)
    .join("\n");

  const scopeLine = pagePlan.ownerScope ? `\nSCOPE TEMATICO: ${pagePlan.ownerScope}` : "";

  const prompt = `You are the Hub Writer for the wiki. Write the OVERVIEW page "${pagePlan.title}" (slug: ${slug}, pageType: ${pagePlan.pageType}).${scopeLine}

DESCRIPTION (your starting point): ${pagePlan.description || "(none)"}

CHILD LEAVES (le pagine figlie che DEVI citare TUTTE come [[wikilinks]]):
${childrenDesc}

═══════════════════════════════════════════════════════════
HUB WRITER RULES (CRITICAL)
═══════════════════════════════════════════════════════════
1. LANGUAGE: italiano. Tutto.
2. Questa è una pagina HUB — solo OVERVIEW narrativa, MAI fatti specifici.
3. Devi citare OGNI child leaf elencato sopra con [[wikilink]] al suo slug — non saltarne nessuno.
4. Connetti i leaf con prosa coesa che renda esplicite le RELAZIONI semantiche tra loro (cosa è acuto vs cronico, cosa è personale vs condiviso, cosa è strutturale vs evento). Non scrivere una bullet list mascherata da prosa.
5. NON inventare fatti. Lavora SOLO con i titoli + description dei leaf qui forniti.
6. Lunghezza: 2-4 brevi paragrafi (~150-400 parole). Concisi ma narrativi.
7. NESSUN tag <wikiauth> in una pagina hub (gli hub non hanno fatti propri, quindi nessun ACL).

═══════════════════════════════════════════════════════════
RESPONSE FORMAT (JSON valido, no markdown fence)
═══════════════════════════════════════════════════════════
{
  "mergedBody": "Markdown della pagina con [[wikilinks]] a tutti i child leaf",
  "description": "1-2 sentence description of the page",
  "aliases": ["Alternative", "Names"]
}

IMPORTANT: Escape quotes (\\") and newlines (\\\\n) in strings.`;

  let mergedBody = "";
  let description = pagePlan.description || pagePlan.title;
  let aliases: string[] = [];

  let attempts = 0;
  const maxAttempts = 2;
  while (attempts < maxAttempts) {
    try {
      attempts++;
      logger.info(`[Hub Writer] Writing "${pagePlan.title}" with Flash (attempt ${attempts}/${maxAttempts})...`);
      const response = await callLlmTask(api, prompt, "hub-writer", 90000, FLASH_MODEL, "minimal");
      const parsed = parseJsonFromLlm(response, `compileHubPage(${slug})`, logger);
      if (parsed.mergedBody) mergedBody = parsed.mergedBody.replace(/\\n/g, "\n");
      if (parsed.description) description = parsed.description;
      if (Array.isArray(parsed.aliases)) aliases = parsed.aliases;
      break;
    } catch (e) {
      if (attempts >= maxAttempts) {
        logger.error(`[Hub Writer] Failed for "${slug}" after ${maxAttempts}: ${e}`);
        throw e;
      } else {
        logger.warn(`[Hub Writer] Failed for "${slug}" (attempt ${attempts}). Retrying...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  if (!mergedBody) throw new Error(`[Hub Writer] No content for "${slug}"`);

  // Tags semplificati: hub_slug + pageType
  const tagsSet = new Set<string>([slug, pagePlan.pageType]);
  const tagsYaml = Array.from(tagsSet).map(t => `  - ${t.replace(/\s+/g, "_")}`).join("\n");
  const aliasesYaml = aliases.length > 0 ? "\n" + aliases.map(a => `  - "${a}"`).join("\n") : " []";

  const content = [
    "---",
    `title: "${pagePlan.title}"`,
    `description: "${description.replace(/"/g, "'")}"`,
    `created: ${createdDate}`,
    `updated: ${now}`,
    `aliases:${aliasesYaml}`,
    `tags:\n${tagsYaml}`,
    `pageType: ${pagePlan.pageType}`,
    `isHub: true`,
    "---",
    "",
    mergedBody.trim(),
    ""
  ].join("\n");

  if (existingContent !== content) {
    fs.writeFileSync(filePath, content, "utf-8");
    fs.writeFileSync(shadowFilePath, content, "utf-8");
    logger.info(`[Hub Writer] ${relativePath} written (${pagePlan.childLeaves.length} children)`);
    return true;
  }
  return false;
}

/**
 * Cronista — scrive una pagina LEAF con i suoi fatti primari.
 * NON riceve i testi dei fatti delle altre pagine: solo l'index slug→description.
 * Questo previene la duplicazione contenutistica cross-page.
 */
async function compileLeafPage(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  plan: CompilationPlan,
  slug: string,
  logger: any
): Promise<boolean> {
  const pagePlan = plan.pages[slug];
  const fileName = `${slug}.md`;
  const relativePath = path.join("pages", fileName);
  const filePath = path.join(config.wikiPath, relativePath);
  const shadowFilePath = getShadowPath(config, relativePath);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.mkdirSync(path.dirname(shadowFilePath), { recursive: true });

  const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  const now = new Date().toISOString().split("T")[0];
  let createdDate = now;
  if (existingContent) {
    const match = existingContent.match(/^created:\s*(.+)$/m);
    if (match) createdDate = match[1].trim();
  }

  const primaryFactsText = pagePlan.primaryFacts.length > 0
    ? pagePlan.primaryFacts.map(f => {
      let line = `- [${f.factType.toUpperCase()}] ${f.text}`;
      if (f.ownerType && f.ownerType !== "global") {
        line += ` [ACL: type="${f.ownerType}" owner="${f.ownerId}" sender="${f.senderId}"]`;
      }
      return line;
    }).join("\n")
    : "(no primary facts — write only a brief introduction)";

  // Index "slug → description" delle altre pagine — il Cronista NON vede i loro fatti
  const pageIndex = plan.compilationOrder
    .filter(s => s !== slug)
    .map(s => {
      const p = plan.pages[s];
      if (!p) return null;
      return `- [[${s}]]: ${p.description || p.title}`;
    })
    .filter(Boolean)
    .join("\n");

  const recommendedLinks = (plan.linkGraph[slug] || []).map(l => `[[${l}]]`).join(", ");

  // User aliases for normalization
  let userAliasesText = "";
  try {
    const users = db.prepare("SELECT names FROM users").all() as Array<{ names: string }>;
    const aliasLines: string[] = [];
    for (const u of users) {
      const names = JSON.parse(u.names) as string[];
      if (names.length > 1) {
        const canonical = names[0];
        const userSlug = canonical.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        aliasLines.push(`- ${names.slice(1).join(", ")} → usa [[${userSlug}]]`);
      }
    }
    if (aliasLines.length > 0) {
      userAliasesText = "\n\nUSER ALIASES (normalize aliases to canonical):\n" + aliasLines.join("\n");
    }
  } catch { }

  const parentHubLine = pagePlan.parentHub ? `\nPARENT HUB: [[${pagePlan.parentHub}]]` : "";

  const prompt = `You are the Chronicler of a personal wiki. You are writing the LEAF page "${pagePlan.title}" (slug: ${slug}, pageType: ${pagePlan.pageType}).${parentHubLine}

═══════════════════════════════════════════════════════════
LANGUAGE: Write ALL output in Italian.
═══════════════════════════════════════════════════════════

═══════════════════════════════════════════════════════════
PRIMARY FACTS (your ONLY source of factual content for this page)
═══════════════════════════════════════════════════════════
${primaryFactsText}

═══════════════════════════════════════════════════════════
PAGES IN THE WIKI (use ONLY for [[wikilinks]] — you do NOT see their facts)
═══════════════════════════════════════════════════════════
${pageIndex}

RECOMMENDED LINKS for this page: ${recommendedLinks || "none specific"}${userAliasesText}

═══════════════════════════════════════════════════════════
ONE FACT, ONE PAGE — CRITICAL RULES
═══════════════════════════════════════════════════════════
1. Scrivi SOLO i primary facts elencati sopra. Sono i tuoi.
2. Quando menzioni un'altra pagina (persona, gruppo, concept), usa SOLO il [[wikilink]] al suo slug. NON parafrasare il suo contenuto: tu non lo conosci, e i suoi fatti vivono solo lì.
3. Esempio CORRETTO: "Le abitudini sportive di [[gollum]] sono raccolte separatamente."
4. Esempio SBAGLIATO: "Le abitudini sportive di [[gollum]] includono karate il lunedì e breakdance il mercoledì." — NO. Quel dettaglio non sta sulla tua pagina.

═══════════════════════════════════════════════════════════
STYLE
═══════════════════════════════════════════════════════════
- Prosa narrativa coesa, NON bullet lists.
- I [[wikilink]] vanno inseriti naturalmente nel testo.
- Non trasformare la pagina in un calendario di appuntamenti: usa eventi datati come EVIDENZA di abitudini/ruoli, non come agenda.

═══════════════════════════════════════════════════════════
ACL — wrap fatti con tag <wikiauth>
═══════════════════════════════════════════════════════════
Some facts have [ACL: type="..." owner="..." sender="..."].
Wrap the corresponding text with:
<wikiauth type="user" owner="gollum" sender="frodo">testo riservato</wikiauth>
Public facts (no ACL) restano testo semplice.

═══════════════════════════════════════════════════════════
RESPONSE FORMAT (JSON valido, no markdown fence)
═══════════════════════════════════════════════════════════
{
  "mergedBody": "Markdown completo con <wikiauth> e [[wikilinks]]",
  "description": "1-2 sentence description",
  "aliases": ["Alt", "Names"]
}

IMPORTANT: Escape quotes (\\") and newlines (\\\\n) in strings.`;

  let mergedBody = "";
  let description = pagePlan.description || pagePlan.title;
  let aliases: string[] = [];

  let attempts = 0;
  const maxAttempts = 2;
  while (attempts < maxAttempts) {
    try {
      attempts++;
      logger.info(`[Cronista] Writing leaf "${pagePlan.title}" with Pro (attempt ${attempts}/${maxAttempts})...`);
      const response = await callLlmTask(api, prompt, "cronista", 180000, PRO_MODEL, "low");
      const parsed = parseJsonFromLlm(response, `compileLeafPage(${slug})`, logger);
      if (parsed.mergedBody) mergedBody = parsed.mergedBody.replace(/\\n/g, "\n");
      if (parsed.description) description = parsed.description;
      if (Array.isArray(parsed.aliases)) aliases = parsed.aliases;
      break;
    } catch (e) {
      if (attempts >= maxAttempts) {
        logger.error(`[Cronista] Pro failed for "${slug}": ${e}`);
        throw e;
      } else {
        logger.warn(`[Cronista] Pro failed for "${slug}" (attempt ${attempts}). Retrying...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  if (!mergedBody) throw new Error(`[Cronista] No content for "${slug}"`);

  // Tag semplificati: slug + pageType + parentHub (se presente)
  const tagsSet = new Set<string>([slug, pagePlan.pageType]);
  if (pagePlan.parentHub) tagsSet.add(pagePlan.parentHub);

  const sourcesSet = new Set<string>();
  for (const f of pagePlan.primaryFacts) {
    if (f.senderId) sourcesSet.add(`sender:${f.senderId}`);
  }

  const tagsYaml = Array.from(tagsSet).map(t => `  - ${t.replace(/\s+/g, "_")}`).join("\n");
  const aliasesYaml = aliases.length > 0 ? "\n" + aliases.map(a => `  - "${a}"`).join("\n") : " []";
  const sourcesYaml = Array.from(sourcesSet).map(s => `  - "${s}"`).join("\n");

  const content = [
    "---",
    `title: "${pagePlan.title}"`,
    `description: "${description.replace(/"/g, "'")}"`,
    `created: ${createdDate}`,
    `updated: ${now}`,
    `aliases:${aliasesYaml}`,
    `tags:\n${tagsYaml}`,
    `pageType: ${pagePlan.pageType}`,
    pagePlan.parentHub ? `parentHub: ${pagePlan.parentHub}` : "",
    `sources:\n${sourcesYaml}`,
    "---",
    "",
    mergedBody.trim(),
    ""
  ].filter(l => l !== "").join("\n");

  if (existingContent !== content) {
    fs.writeFileSync(filePath, content, "utf-8");
    fs.writeFileSync(shadowFilePath, content, "utf-8");
    logger.info(`[Cronista] ${relativePath} written (${pagePlan.primaryFacts.length} primary facts)`);
    return true;
  }
  return false;
}
