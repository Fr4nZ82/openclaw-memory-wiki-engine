/**
 * wiki-reviewer.ts — Stadio 4: Il Revisore
 *
 * QA pass post-compilazione. Verifica:
 *   1. Pagine vuote (0 fatti, 0 children) — anomalia rispetto all'Architetto
 *   2. Duplicazione contenutistica cross-page (n-gram overlap)
 *   3. Link bidirezionali mancanti
 *   4. Concept_leaf con stesso fatto primary in 2+ pagine (sanity)
 *
 * Le issue di severity "error" sono LOGGATE ma non bloccanti.
 * L'utente può rispondere con `/dream rebuild` per forzare full rebuild.
 *
 * Niente più chiamate LLM: review puramente deterministica.
 */

import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import type { PluginConfig } from "./config";
import type { CompilationPlan } from "./wiki-planner";
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
// Helpers — n-gram overlap detector for content duplication
// ---------------------------------------------------------------------------

/** Strip frontmatter and HTML/wikilink markup from a page body. */
function stripPageBody(content: string): string {
  // Remove YAML frontmatter
  const fmMatch = content.match(/^---[\s\S]*?---\s*/);
  let body = fmMatch ? content.slice(fmMatch[0].length) : content;
  // Remove <wikiauth ...> tags but keep inner text
  body = body.replace(/<wikiauth\s+[^>]*>/g, "").replace(/<\/wikiauth>/g, "");
  // Remove [[wikilinks]] keeping the slug as plain word
  body = body.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1");
  // Lowercase + strip punctuation
  return body.toLowerCase().replace(/[^\w\sàèéìòù]/g, " ").replace(/\s+/g, " ").trim();
}

/** Word-level n-grams for a body. */
function nGrams(body: string, n: number): Set<string> {
  const words = body.split(" ").filter(w => w.length > 2); // skip stopword-ish short words
  const grams = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    grams.add(words.slice(i, i + n).join(" "));
  }
  return grams;
}

/** Jaccard similarity of two n-gram sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const g of a) if (b.has(g)) intersect++;
  const union = a.size + b.size - intersect;
  return union > 0 ? intersect / union : 0;
}

// ---------------------------------------------------------------------------
// Il Revisore
// ---------------------------------------------------------------------------

/**
 * Reviews the compiled wiki for structural and content issues.
 * Operates on the on-disk .md files + plan metadata.
 */
export async function reviewWiki(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  plan: CompilationPlan,
  logger: any
): Promise<ReviewResult> {
  const issues: ReviewIssue[] = [];

  // ---- Check 1: empty pages ----
  for (const [slug, page] of Object.entries(plan.pages)) {
    const isHub =
      (page.pageType === "concept_hub" || page.pageType === "group_theme") &&
      page.primaryFacts.length === 0;
    if (isHub && page.childLeaves.length === 0) {
      issues.push({
        severity: "error",
        page: slug,
        message: `Hub "${slug}" non ha né fatti né child leaves.`,
        suggestion: "Architect dovrebbe aver eliminato questa pagina. Verifica.",
      });
    }
    if (page.pageType === "concept_leaf" && page.primaryFacts.length === 0) {
      issues.push({
        severity: "error",
        page: slug,
        message: `Concept leaf "${slug}" senza fatti — dovrebbe essere stato rimosso.`,
        suggestion: "Verifica garbage collection nell'Architect.",
      });
    }
  }

  // ---- Check 2: same fact assigned to 2+ pages (sanity) ----
  const factHomes = new Map<string, string[]>(); // fact_id → pages[]
  for (const [slug, page] of Object.entries(plan.pages)) {
    for (const f of page.primaryFacts) {
      if (!factHomes.has(f.id)) factHomes.set(f.id, []);
      factHomes.get(f.id)!.push(slug);
    }
  }
  for (const [factId, pages] of factHomes) {
    if (pages.length > 1) {
      issues.push({
        severity: "error",
        page: pages.join(","),
        message: `Fact ${factId} è primary in ${pages.length} pagine: ${pages.join(", ")}.`,
        suggestion: "Bug nell'Architetto: ogni fatto deve avere UNA sola pagina home.",
      });
    }
  }

  // ---- Check 3: bidirectional link consistency ----
  for (const [slug, links] of Object.entries(plan.linkGraph)) {
    for (const target of links) {
      const reverse = plan.linkGraph[target] || [];
      if (!reverse.includes(slug)) {
        issues.push({
          severity: "warning",
          page: slug,
          message: `Link non bidirezionale: ${slug} → ${target} ma non ritorno.`,
        });
      }
    }
  }

  // ---- Check 4: content duplication (n-gram overlap on .md bodies) ----
  // Read all generated pages and compute pairwise jaccard on 6-grams.
  // Threshold 0.20 = circa 1 paragrafo replicato letteralmente è già rosso flag.
  const pagesDir = path.join(config.wikiPath, "pages");
  if (fs.existsSync(pagesDir)) {
    const files = fs.readdirSync(pagesDir).filter(f => f.endsWith(".md"));
    const bodies: { slug: string; grams: Set<string> }[] = [];
    for (const f of files) {
      const slug = f.replace(/\.md$/, "");
      // Skip hub pages from duplicate detection: they intentionally reference children
      const page = plan.pages[slug];
      if (!page) continue;
      const isHubPage =
        page.primaryFacts.length === 0 &&
        (page.pageType === "concept_hub" || page.pageType === "group_theme");
      if (isHubPage) continue;
      try {
        const raw = fs.readFileSync(path.join(pagesDir, f), "utf-8");
        const body = stripPageBody(raw);
        if (body.length < 100) continue; // skip empty/very short
        bodies.push({ slug, grams: nGrams(body, 6) });
      } catch (e) {
        dlog(`Read failed for ${f}: ${e}`);
      }
    }

    // Pairwise comparison
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const sim = jaccard(bodies[i].grams, bodies[j].grams);
        if (sim > 0.20) {
          issues.push({
            severity: "error",
            page: `${bodies[i].slug}↔${bodies[j].slug}`,
            message: `Duplicazione contenutistica rilevata (jaccard 6-gram = ${sim.toFixed(3)}) tra "${bodies[i].slug}" e "${bodies[j].slug}".`,
            suggestion: "Il Cronista ha probabilmente parafrasato fatti di un'altra pagina. /dream rebuild per riprovare.",
          });
        } else if (sim > 0.12) {
          issues.push({
            severity: "warning",
            page: `${bodies[i].slug}↔${bodies[j].slug}`,
            message: `Possibile sovrapposizione contenutistica (jaccard 6-gram = ${sim.toFixed(3)}) tra "${bodies[i].slug}" e "${bodies[j].slug}".`,
          });
        }
      }
    }
  }

  // ---- Logging ----
  for (const issue of issues) {
    const fn = issue.severity === "error" ? logger.error : issue.severity === "warning" ? logger.warn : logger.info;
    fn.call(logger, `[Revisore] [${issue.severity}] ${issue.page}: ${issue.message}`);
    if (issue.suggestion) dlog(`  → ${issue.suggestion}`);
  }

  const errorCount = issues.filter(i => i.severity === "error").length;
  const warningCount = issues.filter(i => i.severity === "warning").length;
  const ok = errorCount === 0;
  const summary = ok
    ? `OK — ${plan.compilationOrder.length} pagine, ${warningCount} warning, 0 errori.`
    : `${errorCount} errori, ${warningCount} warning su ${plan.compilationOrder.length} pagine.`;

  logger.info(`[Revisore] Review complete: ${ok ? "✅ OK" : "⚠️ Issues"} — ${summary}`);

  return { ok, issues, summary };
}
