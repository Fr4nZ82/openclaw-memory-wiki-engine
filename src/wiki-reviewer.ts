/**
 * wiki-reviewer.ts — Stadio 4: Il Revisore
 *
 * Quality assurance pass. Receives the index of all generated pages
 * and checks for remaining duplications, missing cross-references,
 * and structural issues.
 *
 * Uses Gemini Pro (single call) for intelligent review.
 */

import type Database from "better-sqlite3";
import type { PluginConfig } from "./config";
import type { CompilationPlan } from "./wiki-planner";
import { callLlmTask } from "./classifier";
import { dbg } from "./debug";

const dlog = dbg("wiki-reviewer");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewIssue {
  severity: "info" | "warning" | "error";
  page: string;
  message: string;
  suggestion?: string;
}

export interface ReviewResult {
  ok: boolean;
  issues: ReviewIssue[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Il Revisore
// ---------------------------------------------------------------------------

/**
 * Reviews the compiled wiki for structural issues.
 * 
 * @param plan - The compilation plan used to generate the wiki
 * @returns ReviewResult with any issues found
 */
export async function reviewWiki(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  plan: CompilationPlan,
  logger: any
): Promise<ReviewResult> {
  const PRO_MODEL = "gemini-3.1-pro-preview";

  // Build page index for the reviewer
  const pageRows = plan.compilationOrder.map(slug => {
    const p = plan.pages[slug];
    if (!p) return null;
    const primaryCount = p.primaryFacts.length;
    const referencedCount = p.referencedFacts.length;
    const links = (plan.linkGraph[slug] || []).join(", ");
    return `| ${slug} | ${p.pageType} | ${p.description || p.title} | ${primaryCount} | ${referencedCount} | ${links} |`;
  }).filter(Boolean).join("\n");

  const prompt = `Sei il Revisore di qualità di una wiki personale appena generata.
Verifica la struttura e segnala problemi.

INDICE DELLA WIKI:
| Pagina | Tipo | Descrizione | Fatti primari | Fatti referenziati | Link |
|--------|------|-------------|--------------|-------------------|------|
${pageRows}

PAGINE UNITE (merge eseguiti):
${plan.mergedPages.length > 0 ? plan.mergedPages.map(m => `- "${m.from}" → fusa in "${m.into}" (${m.reason})`).join("\n") : "Nessun merge eseguito."}

VERIFICA:
1. Ci sono pagine con 0 fatti primari E 0 fatti referenziati? (pagine vuote)
2. Ci sono pagine che dovrebbero avere link bidirezionali ma non li hanno?
3. Ci sono pagine persona senza link ad altre pagine persona della stessa famiglia?
4. C'è un concetto che compare come primario in 3+ pagine? (duplicazione residua)
5. Il numero totale di fatti (${plan.factCount}) è coerente con la distribuzione?

Rispondi con un JSON:
{
  "ok": true/false,
  "issues": [
    { "severity": "warning", "page": "slug", "message": "descrizione problema", "suggestion": "suggerimento fix" }
  ],
  "summary": "Riassunto di 1-2 frasi della qualità della wiki"
}

Se non ci sono problemi, rispondi con ok: true e issues vuoto.`;

  try {
    logger.info(`[Revisore] Reviewing wiki structure (${plan.compilationOrder.length} pages)...`);
    const response = await callLlmTask(api, prompt, "revisore", 120000, PRO_MODEL);

    let parsed: ReviewResult;
    try {
      let cleaned = response.trim();
      if (cleaned.startsWith("```json")) {
        cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
      } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
      }
      parsed = JSON.parse(cleaned);
    } catch (err) {
      logger.error(`[Revisore] JSON parse failed: ${err}`);
      return { ok: true, issues: [], summary: "Review parse failed, assuming ok" };
    }

    // Log results
    if (parsed.issues && parsed.issues.length > 0) {
      for (const issue of parsed.issues) {
        const logFn = issue.severity === "error" ? logger.error : issue.severity === "warning" ? logger.warn : logger.info;
        logFn(`[Revisore] [${issue.severity}] ${issue.page}: ${issue.message}`);
        if (issue.suggestion) dlog(`  → ${issue.suggestion}`);
      }
    }

    logger.info(`[Revisore] Review complete: ${parsed.ok ? "✅ OK" : "⚠️ Issues found"} — ${parsed.summary}`);
    return parsed;

  } catch (err) {
    logger.error(`[Revisore] Review failed: ${err}`);
    return { ok: true, issues: [], summary: `Review failed: ${err}` };
  }
}
