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
    let response = await callLlmTask(api, prompt);

    const facts = JSON.parse(typeof response === "string" ? response : JSON.stringify(response));
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
  const createdDate = fs.existsSync(filePath) ? fs.statSync(filePath).birthtime.toISOString().split("T")[0] : now;

  // Extract tags, sources, and check confidence
  const tagsSet = new Set<string>([targetEntity.topic]);
  const sourcesSet = new Set<string>();
  let hasMediumConfidence = false;

  const factsList = facts.map(f => {
    try {
      const ts = JSON.parse(f.topics);
      if (Array.isArray(ts)) ts.forEach((t: string) => tagsSet.add(t.toLowerCase()));
    } catch {}
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
    } catch {}

    const prompt = `Rewrite the following wiki page by merging the new facts.
DO NOT use bullet point lists if possible. Write a cohesive, narrative prose describing the entity/concept.
Insert Obsidian-compatible [[wikilinks]] for known concepts and entities naturally in the text.
If old facts are contradicted by new ones, update the narrative.

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

Known slugs for wikilinks:
${knownSlugs.length > 0 ? knownSlugs.join(", ") : "None yet."}

Current Text:
"""
${existingContent.replace(/^---[\s\S]*?---\s*/, "")}
"""

Facts to include/merge:
"""
${factsList}
"""`;

    try {
      if (config.debug) logger.debug(`[Wiki Compiler] Requesting semantic merge for ${targetEntity.title} from LLM...`);
      const response = await callLlmTask(api, prompt);
      
      const parsed = typeof response === "string" ? JSON.parse(response) : response;
      if (parsed.mergedBody) mergedBody = parsed.mergedBody;
      if (parsed.description) description = parsed.description;
      if (Array.isArray(parsed.aliases)) aliases = parsed.aliases;
      
    } catch (e) {
      logger.error(`[Wiki Compiler] LLM failed for ${relativePath}. Aborting compilation: ${e}`);
      throw e;
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
  const tagsYaml = Array.from(tagsSet).map(t => `  - ${t}`).join("\n");
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
