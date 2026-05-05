/**
 * wiki-planner.ts — La Forgia della Wiki (Stadi 0-2)
 *
 * Implements the first three stages of the Wiki Forge pipeline:
 *
 *   0. IL FONDITORE  — Scaffolds foundation pages from USERS.md (deterministic, zero LLM)
 *   1. IL CARTOGRAFO — Classifies all facts into pages using Gemini Flash (1 call)
 *   2. L'ARCHITETTO  — Validates, optimizes, and builds the compilation plan (deterministic)
 *
 * The output is a CompilationPlan that the Cronista (wiki-compiler.ts) uses
 * to write each page with full cross-page awareness.
 */

import type Database from "better-sqlite3";
import type { PluginConfig } from "./config";
import type { Fact } from "./db";
import { jsonToTopics } from "./utils";
import { callLlmTask } from "./classifier";
import { getCachedRegistry } from "./users-registry";
import * as fs from "fs";
import * as path from "path";
import { dbg } from "./debug";

const dlog = dbg("wiki-planner");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FactForPage {
  id: string;
  text: string;
  factType: string;
  ownerType: string;
  ownerId: string;
  senderId: string;
}

export interface FactRef {
  id: string;
  text: string;
  primaryPage: string;
}

export interface PagePlan {
  slug: string;
  title: string;
  description: string;
  pageType: "person" | "group_theme" | "concept";
  ownerScope?: string;
  primaryFacts: FactForPage[];
  referencedFacts: FactRef[];
  outgoingLinks: string[];
  incomingLinks: string[];
}

export interface CompilationPlan {
  pages: Record<string, PagePlan>;
  mergedPages: { from: string; into: string; reason: string }[];
  linkGraph: Record<string, string[]>;
  compilationOrder: string[];
  groupScopes: Record<string, string[]>;
  generatedAt: string;
  factCount: number;
}

// ---------------------------------------------------------------------------
// Stadio 0: Il Fonditore (deterministic, zero LLM)
// ---------------------------------------------------------------------------

/**
 * Creates foundation pages from USERS.md.
 * Person pages for each user, group pages for each group.
 * These are immutable anchors — the Cartographer cannot remove them.
 */
function buildFoundationPages(
  db: Database.Database,
  logger: any
): { pages: Record<string, PagePlan>; groupScopes: Record<string, string[]> } {
  const pages: Record<string, PagePlan> = {};
  const groupScopes: Record<string, string[]> = {};

  const registry = getCachedRegistry();

  // --- Person pages from DB users table ---
  const users = db.prepare("SELECT names, sender_id FROM users").all() as Array<{
    names: string;
    sender_id: string;
  }>;

  // Load user details from registry for relazioni, born, groups
  const registryUsers = registry?.users ?? [];
  const registryGroups = registry?.groups ?? [];

  for (const u of users) {
    const names = JSON.parse(u.names) as string[];
    if (names.length === 0) continue;
    const canonical = names[0];
    const slug = canonical.toLowerCase().replace(/[^a-z0-9]+/g, "_");

    // Enrich from registry
    const regUser = registryUsers.find(ru => ru.slug === slug || ru.sender_id === u.sender_id);

    pages[slug] = {
      slug,
      title: canonical.charAt(0).toUpperCase() + canonical.slice(1),
      description: "",
      pageType: "person",
      primaryFacts: [],
      referencedFacts: [],
      outgoingLinks: [],
      incomingLinks: [],
    };

    // Add structural info as synthetic facts (from USERS.md, not the DB)
    if (regUser) {
      // Relations generate outgoing links
      if (regUser.relazioni) {
        // Extract linked user slugs from relazioni text
        for (const otherUser of registryUsers) {
          if (otherUser.slug !== slug) {
            const otherNames = [otherUser.slug, ...otherUser.aliases].map(n => n.toLowerCase());
            const relLower = regUser.relazioni.toLowerCase();
            if (otherNames.some(n => relLower.includes(n))) {
              if (!pages[slug].outgoingLinks.includes(otherUser.slug)) {
                pages[slug].outgoingLinks.push(otherUser.slug);
              }
            }
          }
        }
      }
      // Groups generate outgoing links to group pages
      for (const g of regUser.groups) {
        const groupSlug = g.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        if (!pages[slug].outgoingLinks.includes(groupSlug)) {
          pages[slug].outgoingLinks.push(groupSlug);
        }
      }
    }
  }

  // --- Group pages ---
  const dbGroups = db.prepare("SELECT id, name, description, scope FROM user_groups").all() as Array<{
    id: string;
    name: string;
    description: string;
    scope: string | null;
  }>;

  for (const g of dbGroups) {
    const slug = g.id.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    let scopeArr: string[] = [];
    if (g.scope) {
      try { scopeArr = JSON.parse(g.scope) as string[]; } catch {}
    }
    groupScopes[slug] = scopeArr;

    // Find members of this group
    const members = db.prepare(
      "SELECT user_id FROM group_members WHERE group_id = ?"
    ).all(g.id) as Array<{ user_id: string }>;
    const memberSlugs = members.map(m => m.user_id.toLowerCase().replace(/[^a-z0-9]+/g, "_"));

    pages[slug] = {
      slug,
      title: g.name || g.id.charAt(0).toUpperCase() + g.id.slice(1),
      description: g.description || "",
      pageType: "group_theme",
      ownerScope: scopeArr.length > 0 ? scopeArr.join("; ") : undefined,
      primaryFacts: [],
      referencedFacts: [],
      outgoingLinks: memberSlugs.filter(m => m !== slug),
      incomingLinks: [],
    };
  }

  logger.info(`[Fonditore] Created ${Object.keys(pages).length} foundation pages (${users.length} persons, ${dbGroups.length} groups)`);
  return { pages, groupScopes };
}

// ---------------------------------------------------------------------------
// Stadio 1: Il Cartografo (Gemini Flash, 1 call)
// ---------------------------------------------------------------------------

/**
 * Classifies ALL active facts into pages using a single Gemini Flash call.
 * Returns a blueprint mapping fact IDs to primary/secondary pages.
 */
async function classifyFacts(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  allFacts: Fact[],
  foundationPages: Record<string, PagePlan>,
  groupScopes: Record<string, string[]>,
  logger: any
): Promise<CartographerBlueprint> {

  // Build the foundation pages description for the prompt
  const foundationDesc = Object.values(foundationPages).map(p => {
    let line = `- [${p.pageType}] ${p.slug}`;
    if (p.pageType === "person") {
      line += ` — pagina persona`;
    } else if (p.pageType === "group_theme") {
      line += ` — scope: ${p.ownerScope || "nessuno"}`;
    }
    return line;
  }).join("\n");

  // Build fact list for the prompt
  const factLines = allFacts.map(f => {
    const topics = jsonToTopics(f.topics).join(", ");
    return `[id:${f.id}] "${f.text}" topics=[${topics}] owner_type=${f.owner_type} owner_id=${f.owner_id}`;
  }).join("\n");

  const prompt = `Sei il Cartografo di una wiki personale. Devi organizzare ${allFacts.length} fatti in pagine.

PAGINE GIÀ ESISTENTI (fondazione, NON eliminabili):
${foundationDesc}

REGOLE DI ASSEGNAZIONE:
1. Fatto con owner_type="user" (bio, preferenza, abitudine personale)
   → primary_page = pagina della PERSONA (già esistente)
   → referenced_pages = max 1-2 pagine tematiche correlate

2. Fatto con owner_type="group" (rientra nello scope del gruppo)
   → primary_page = pagina TEMATICA più adatta
   → Se non esiste una pagina tematica adatta, CREANE UNA NUOVA (inventa un slug in italiano, senza spazi, usa underscore)
   → referenced_pages = pagine delle PERSONE coinvolte

3. Fatto con owner_type="global" o senza owner specifico
   → primary_page = la pagina tematica più adatta
   → Se il fatto riguarda chiaramente una persona, usa quella persona come primary

4. Ogni fatto ha ESATTAMENTE 1 primary_page
5. referenced_pages: max 1-2 pagine dove il fatto è rilevante ma secondario
6. I nomi delle nuove pagine devono essere in italiano, senza spazi (usa underscore)

FATTI DA CLASSIFICARE:
${factLines}

Rispondi con un JSON con questa struttura ESATTA:
{
  "assignments": [
    { "fact_id": 1, "primary_page": "frodo", "referenced_pages": ["lavoro"] },
    { "fact_id": 2, "primary_page": "regole_casa", "referenced_pages": ["famiglia", "gollum"] }
  ],
  "new_pages": [
    { "slug": "regole_casa", "title": "Regole della casa", "description": "Regole e abitudini domestiche della famiglia" }
  ],
  "suggested_links": {
    "regole_casa": ["famiglia", "gollum"]
  }
}`;

  logger.info(`[Cartografo] Classifying ${allFacts.length} facts with Flash (prompt: ${prompt.length} chars)...`);

  const response = await callLlmTask(api, prompt, "cartografo", 120000);

  // Parse response
  let parsed: CartographerBlueprint;
  try {
    let cleaned = response.trim();
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.error(`[Cartografo] JSON parse failed! Raw response:\n${response.substring(0, 500)}`);
    throw err;
  }

  logger.info(`[Cartografo] Classified ${parsed.assignments?.length || 0} facts, ${parsed.new_pages?.length || 0} new pages suggested`);
  return parsed;
}

interface CartographerBlueprint {
  assignments: Array<{
    fact_id: string;
    primary_page: string;
    referenced_pages: string[];
  }>;
  new_pages: Array<{
    slug: string;
    title: string;
    description: string;
  }>;
  suggested_links: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Stadio 2: L'Architetto (deterministic, zero LLM)
// ---------------------------------------------------------------------------

/**
 * Validates the Cartographer's blueprint and builds the final CompilationPlan.
 * - Validates coverage (every fact assigned, no orphans)
 * - Creates new pages suggested by Cartographer
 * - Resolves merges (pages with 0 primary facts get absorbed)
 * - Builds bidirectional link graph
 * - Determines compilation order (persons → groups → concepts)
 */
function buildCompilationPlan(
  allFacts: Fact[],
  foundationPages: Record<string, PagePlan>,
  blueprint: CartographerBlueprint,
  groupScopes: Record<string, string[]>,
  logger: any
): CompilationPlan {
  // Start with foundation pages
  const pages: Record<string, PagePlan> = {};
  for (const [slug, page] of Object.entries(foundationPages)) {
    pages[slug] = { ...page, primaryFacts: [], referencedFacts: [] };
  }

  // Create new pages from Cartographer suggestions
  for (const np of (blueprint.new_pages || [])) {
    const slug = np.slug.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (!pages[slug]) {
      pages[slug] = {
        slug,
        title: np.title,
        description: np.description,
        pageType: "concept",
        primaryFacts: [],
        referencedFacts: [],
        outgoingLinks: [],
        incomingLinks: [],
      };
      dlog(`Architect: created new concept page "${slug}"`);
    }
  }

  // Build a quick fact lookup
  const factMap = new Map<string, Fact>();
  for (const f of allFacts) factMap.set(f.id, f);

  // Assign facts to pages
  const assignedFactIds = new Set<string>();

  for (const assignment of (blueprint.assignments || [])) {
    const fact = factMap.get(assignment.fact_id);
    if (!fact) {
      dlog(`Architect: fact ${assignment.fact_id} not found in DB, skipping`);
      continue;
    }

    const primarySlug = assignment.primary_page.toLowerCase().replace(/[^a-z0-9]+/g, "_");

    // Ensure primary page exists (create if Cartographer invented one not in new_pages)
    if (!pages[primarySlug]) {
      pages[primarySlug] = {
        slug: primarySlug,
        title: primarySlug.charAt(0).toUpperCase() + primarySlug.slice(1).replace(/_/g, " "),
        description: "",
        pageType: "concept",
        primaryFacts: [],
        referencedFacts: [],
        outgoingLinks: [],
        incomingLinks: [],
      };
      dlog(`Architect: auto-created page "${primarySlug}" from assignment`);
    }

    // Add as primary fact
    pages[primarySlug].primaryFacts.push({
      id: fact.id,
      text: fact.text,
      factType: fact.fact_type,
      ownerType: fact.owner_type,
      ownerId: fact.owner_id,
      senderId: fact.sender_id,
    });
    assignedFactIds.add(fact.id);

    // Add referenced copies
    for (const refPage of (assignment.referenced_pages || [])) {
      const refSlug = refPage.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (refSlug === primarySlug) continue;
      if (!pages[refSlug]) continue; // Only reference existing pages

      pages[refSlug].referencedFacts.push({
        id: fact.id,
        text: fact.text,
        primaryPage: primarySlug,
      });
    }
  }

  // Validation: check for orphan facts
  const orphans = allFacts.filter(f => !assignedFactIds.has(f.id));
  if (orphans.length > 0) {
    logger.warn(`[Architetto] ${orphans.length} orphan facts not assigned by Cartographer, assigning to owners`);
    for (const f of orphans) {
      // Fallback: assign to owner page if it exists
      const ownerSlug = f.owner_id?.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "";
      const targetSlug = pages[ownerSlug] ? ownerSlug : Object.keys(pages)[0];
      if (pages[targetSlug]) {
        pages[targetSlug].primaryFacts.push({
          id: f.id,
          text: f.text,
          factType: f.fact_type,
          ownerType: f.owner_type,
          ownerId: f.owner_id,
          senderId: f.sender_id,
        });
      }
    }
  }

  // Merge resolution: concept pages with 0 primary facts get absorbed
  const mergedPages: { from: string; into: string; reason: string }[] = [];
  const pagesToRemove: string[] = [];

  for (const [slug, page] of Object.entries(pages)) {
    if (page.pageType !== "concept") continue; // Never merge foundation pages
    if (page.primaryFacts.length === 0 && page.referencedFacts.length > 0) {
      // Find the best merge target from referenced facts
      const targetSlugs = page.referencedFacts.map(r => r.primaryPage);
      const targetSlug = targetSlugs[0]; // Most common reference
      if (targetSlug && pages[targetSlug]) {
        // Move referenced facts to target
        for (const ref of page.referencedFacts) {
          if (!pages[targetSlug].referencedFacts.some(r => r.id === ref.id)) {
            pages[targetSlug].referencedFacts.push(ref);
          }
        }
        mergedPages.push({ from: slug, into: targetSlug, reason: "zero primary facts" });
        pagesToRemove.push(slug);
        dlog(`Architect: merging empty page "${slug}" into "${targetSlug}"`);
      }
    }
  }

  for (const slug of pagesToRemove) {
    delete pages[slug];
  }

  // Build bidirectional link graph
  const linkGraph: Record<string, string[]> = {};

  // Start with Cartographer's suggestions
  for (const [slug, links] of Object.entries(blueprint.suggested_links || {})) {
    const normalizedSlug = slug.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (!pages[normalizedSlug]) continue;
    linkGraph[normalizedSlug] = links
      .map(l => l.toLowerCase().replace(/[^a-z0-9]+/g, "_"))
      .filter(l => pages[l] && l !== normalizedSlug);
  }

  // Add links from referenced facts
  for (const [slug, page] of Object.entries(pages)) {
    if (!linkGraph[slug]) linkGraph[slug] = [];
    for (const ref of page.referencedFacts) {
      if (!linkGraph[slug].includes(ref.primaryPage) && ref.primaryPage !== slug) {
        linkGraph[slug].push(ref.primaryPage);
      }
    }
    // Add foundation outgoing links
    for (const link of page.outgoingLinks) {
      if (!linkGraph[slug].includes(link) && pages[link]) {
        linkGraph[slug].push(link);
      }
    }
  }

  // Make links bidirectional
  for (const [slug, links] of Object.entries(linkGraph)) {
    for (const target of links) {
      if (!linkGraph[target]) linkGraph[target] = [];
      if (!linkGraph[target].includes(slug)) {
        linkGraph[target].push(slug);
      }
    }
  }

  // Update pages with computed links
  for (const [slug, page] of Object.entries(pages)) {
    page.outgoingLinks = linkGraph[slug] || [];
    page.incomingLinks = Object.entries(linkGraph)
      .filter(([_, targets]) => targets.includes(slug))
      .map(([source]) => source);
  }

  // Compilation order: persons first, then groups, then concepts
  const compilationOrder = Object.values(pages)
    .sort((a, b) => {
      const order = { person: 0, group_theme: 1, concept: 2 };
      return (order[a.pageType] || 2) - (order[b.pageType] || 2);
    })
    .map(p => p.slug);

  const plan: CompilationPlan = {
    pages,
    mergedPages,
    linkGraph,
    compilationOrder,
    groupScopes,
    generatedAt: new Date().toISOString(),
    factCount: allFacts.length,
  };

  logger.info(`[Architetto] Plan: ${compilationOrder.length} pages (${mergedPages.length} merged), ${allFacts.length} facts, order: ${compilationOrder.join(" → ")}`);
  return plan;
}

// ---------------------------------------------------------------------------
// Public API: orchestrate Stadi 0-2
// ---------------------------------------------------------------------------

/**
 * Runs Stages 0-2 of the Wiki Forge pipeline:
 * Fonditore → Cartografo → Architetto → CompilationPlan
 */
export async function buildWikiPlan(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  logger: any
): Promise<CompilationPlan> {
  // Load all active facts
  const allFacts = db.prepare(
    `SELECT * FROM facts WHERE is_active = 1 ORDER BY fact_type, updated_at DESC`
  ).all() as Fact[];

  if (allFacts.length === 0) {
    logger.warn("[Wiki Planner] No active facts found, creating skeleton-only plan");
  }

  // Stadio 0: Il Fonditore
  logger.info("[Wiki Planner] === Stadio 0: Il Fonditore ===");
  const { pages: foundationPages, groupScopes } = buildFoundationPages(db, logger);

  // Stadio 1: Il Cartografo (skip if no facts)
  let blueprint: CartographerBlueprint = { assignments: [], new_pages: [], suggested_links: {} };
  if (allFacts.length > 0) {
    logger.info("[Wiki Planner] === Stadio 1: Il Cartografo ===");
    blueprint = await classifyFacts(api, db, config, allFacts, foundationPages, groupScopes, logger);
  }

  // Stadio 2: L'Architetto
  logger.info("[Wiki Planner] === Stadio 2: L'Architetto ===");
  const plan = buildCompilationPlan(allFacts, foundationPages, blueprint, groupScopes, logger);

  // Persist plan for debugging and incremental updates
  const planPath = path.join(config.wikiPath, "_meta", "compilation-plan.json");
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
  dlog(`Plan saved to ${planPath}`);

  return plan;
}
