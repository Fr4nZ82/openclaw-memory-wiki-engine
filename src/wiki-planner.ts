/**
 * wiki-planner.ts — La Forgia della Wiki 2.0 (Stadi 0 / 0.5 / 1 / 1.5 / 2)
 *
 * Pipeline:
 *   0.   IL FONDITORE      — leaf canonical USERS.md (persone + gruppi-as-hub)
 *   0.5. TOPOLOGY SEED     — carica concept-registry persistente
 *   1.   IL CARTOGRAFO     — un fatto → una pagina (NO referenced_pages)
 *   1.5. IL CONCILIATORE   — merge semantico dei new_pages contro registry
 *   2.   L'ARCHITETTO      — gerarchia hub→leaf, dirty propagation per link
 *
 * Principi:
 *   - Un fatto vive in UNA pagina sola (la sua "casa").
 *   - Hub tematici NON contengono fatti, solo overview narrativa + wikilinks.
 *   - Concept-registry persistente impedisce duplicati semantici tra REM.
 *   - Dirty propagation: una pagina nuova marca dirty l'hub padre + le pagine
 *     che dovrebbero linkarla.
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

/**
 * @deprecated Conserved for retrocompatibility with wiki-reviewer / topic-index.
 * Always empty in the new pipeline (un fatto = una pagina).
 */
export interface FactRef {
  id: string;
  text: string;
  primaryPage: string;
}

export type PageType = "person" | "group_theme" | "concept_hub" | "concept_leaf";

export interface PagePlan {
  slug: string;
  title: string;
  description: string;
  pageType: PageType;
  /** Per group_theme: scope string for prompt context */
  ownerScope?: string;
  /** Per concept_leaf / person: slug del concept_hub o group_theme parent */
  parentHub?: string;
  /** Per concept_hub / group_theme: slug dei leaf figli (computati dall'Architetto) */
  childLeaves: string[];
  /** Fatti che hanno questa pagina come "casa" (one-fact-one-page). */
  primaryFacts: FactForPage[];
  /** Sempre vuoto nella nuova pipeline — preservato per retrocompat. */
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
  /** Pages whose fingerprint changed since the last plan — only these need recompilation */
  dirtyPages: string[];
}

// ---------------------------------------------------------------------------
// Concept Registry (persistente tra REM)
// ---------------------------------------------------------------------------

export interface ConceptRegistryEntry {
  slug: string;
  title: string;
  description: string;
  pageType: "concept_hub" | "concept_leaf";
  parentHub?: string;
  aliases: string[];
  createdAt: string;
}

export interface ConceptRegistry {
  version: number;
  entries: Record<string, ConceptRegistryEntry>;
  generatedAt: string;
}

const REGISTRY_VERSION = 1;

function loadConceptRegistry(config: PluginConfig, logger: any): ConceptRegistry {
  const regPath = path.join(config.wikiPath, "_meta", "concept-registry.json");
  try {
    if (!fs.existsSync(regPath)) {
      return { version: REGISTRY_VERSION, entries: {}, generatedAt: new Date().toISOString() };
    }
    const raw = fs.readFileSync(regPath, "utf-8");
    const reg = JSON.parse(raw) as ConceptRegistry;
    if (!reg.entries) reg.entries = {};
    return reg;
  } catch (e) {
    logger.warn(`[Topology Seed] Could not load concept registry: ${e}`);
    return { version: REGISTRY_VERSION, entries: {}, generatedAt: new Date().toISOString() };
  }
}

function saveConceptRegistry(config: PluginConfig, registry: ConceptRegistry): void {
  const regPath = path.join(config.wikiPath, "_meta", "concept-registry.json");
  fs.mkdirSync(path.dirname(regPath), { recursive: true });
  fs.writeFileSync(regPath, JSON.stringify(registry, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Stadio 0: Il Fonditore (deterministic, zero LLM)
// ---------------------------------------------------------------------------

/**
 * Crea le pagine di fondazione da USERS.md:
 *   - person leaf per ogni utente registrato
 *   - group_theme (hub-like) per ogni gruppo, con scope come metadati
 * Le persone hanno parentHub = primo gruppo del loro `groups:` field.
 */
function buildFoundationPages(
  db: Database.Database,
  logger: any
): { pages: Record<string, PagePlan>; groupScopes: Record<string, string[]> } {
  const pages: Record<string, PagePlan> = {};
  const groupScopes: Record<string, string[]> = {};

  const registry = getCachedRegistry();
  const registryUsers = registry?.users ?? [];

  // --- Group pages (act as hubs for their members + scope facts) ---
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
      try {
        scopeArr = JSON.parse(g.scope) as string[];
      } catch {}
    }
    groupScopes[slug] = scopeArr;

    pages[slug] = {
      slug,
      title: g.name || g.id.charAt(0).toUpperCase() + g.id.slice(1),
      description: g.description || `Gruppo ${g.name}`,
      pageType: "group_theme",
      ownerScope: scopeArr.length > 0 ? scopeArr.join("; ") : undefined,
      childLeaves: [],
      primaryFacts: [],
      referencedFacts: [],
      outgoingLinks: [],
      incomingLinks: [],
    };
  }

  // --- Person pages (always leaf, parentHub = first group) ---
  const users = db.prepare("SELECT names, sender_id FROM users").all() as Array<{
    names: string;
    sender_id: string;
  }>;

  for (const u of users) {
    const names = JSON.parse(u.names) as string[];
    if (names.length === 0) continue;
    const canonical = names[0];
    const slug = canonical.toLowerCase().replace(/[^a-z0-9]+/g, "_");

    const regUser = registryUsers.find(ru => ru.slug === slug || ru.sender_id === u.sender_id);

    let parentHub: string | undefined;
    const outgoingLinks: string[] = [];

    if (regUser) {
      // First group = primary parent hub
      if (regUser.groups.length > 0) {
        const groupSlug = regUser.groups[0].toLowerCase().replace(/[^a-z0-9]+/g, "_");
        if (pages[groupSlug]) {
          parentHub = groupSlug;
        }
      }

      // Other groups → outgoing links
      for (const g of regUser.groups) {
        const gSlug = g.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        if (pages[gSlug] && !outgoingLinks.includes(gSlug)) {
          outgoingLinks.push(gSlug);
        }
      }

      // Relations → outgoing links to other person pages
      if (regUser.relazioni) {
        const relLower = regUser.relazioni.toLowerCase();
        for (const otherUser of registryUsers) {
          if (otherUser.slug === slug) continue;
          const otherNames = [otherUser.slug, ...otherUser.aliases].map(n => n.toLowerCase());
          if (otherNames.some(n => relLower.includes(n))) {
            if (!outgoingLinks.includes(otherUser.slug)) {
              outgoingLinks.push(otherUser.slug);
            }
          }
        }
      }
    }

    pages[slug] = {
      slug,
      title: canonical.charAt(0).toUpperCase() + canonical.slice(1),
      description: `Pagina personale di ${canonical}`,
      pageType: "person",
      parentHub,
      childLeaves: [],
      primaryFacts: [],
      referencedFacts: [],
      outgoingLinks,
      incomingLinks: [],
    };
  }

  logger.info(
    `[Fonditore] Created ${Object.keys(pages).length} foundation pages (${users.length} persons, ${dbGroups.length} groups)`
  );
  return { pages, groupScopes };
}

// ---------------------------------------------------------------------------
// Stadio 1: Il Cartografo (Gemini Flash, batch)
// ---------------------------------------------------------------------------

interface CartographerAssignment {
  fact_id: string;
  page_slug: string;
}

interface CartographerNewPage {
  slug: string;
  title: string;
  description: string;
  page_type: "concept_hub" | "concept_leaf";
  parent_hub?: string;
}

interface CartographerBlueprint {
  assignments: CartographerAssignment[];
  new_pages: CartographerNewPage[];
}

/**
 * Classifica i fatti in pagine. Ogni fatto ha UN solo `page_slug` (la sua casa).
 * Il Cartografo riceve sempre il concept-registry esistente come "EXISTING PAGES".
 */
async function classifyFacts(
  api: any,
  factsToClassify: Fact[],
  foundationPages: Record<string, PagePlan>,
  registry: ConceptRegistry,
  logger: any
): Promise<CartographerBlueprint> {
  // Foundation pages descriptor
  const foundationDesc = Object.values(foundationPages)
    .map(p => {
      if (p.pageType === "person") {
        return `- [person] ${p.slug} — ${p.title} (parentHub: ${p.parentHub || "—"})`;
      }
      if (p.pageType === "group_theme") {
        return `- [group_hub] ${p.slug} — ${p.title} | scope: ${p.ownerScope || "—"}`;
      }
      return `- [${p.pageType}] ${p.slug}`;
    })
    .join("\n");

  // Concept registry descriptor
  const registryEntries = Object.values(registry.entries);
  const registryDesc =
    registryEntries.length > 0
      ? registryEntries
          .map(e => `- [${e.pageType}] ${e.slug} — ${e.title} | ${e.description}${e.parentHub ? ` (parentHub: ${e.parentHub})` : ""}`)
          .join("\n")
      : "(none yet — empty registry)";

  // Batched classification
  const BATCH_SIZE = 15;
  const batches: Fact[][] = [];
  for (let i = 0; i < factsToClassify.length; i += BATCH_SIZE) {
    batches.push(factsToClassify.slice(i, i + BATCH_SIZE));
  }

  logger.info(
    `[Cartografo] ${factsToClassify.length} facts, ${batches.length} batch da ~${BATCH_SIZE}, registry: ${registryEntries.length} concept pages note`
  );

  const merged: CartographerBlueprint = { assignments: [], new_pages: [] };
  // Track new pages proposed across batches
  const knownSlugs = new Set([...Object.keys(foundationPages), ...Object.keys(registry.entries)]);

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];

    const factLines = batch
      .map(f => {
        const topics = jsonToTopics(f.topics).join(", ");
        return `[id:${f.id}] "${f.text}" topics=[${topics}] owner_type=${f.owner_type} owner_id=${f.owner_id}`;
      })
      .join("\n");

    const prevNewPages =
      merged.new_pages.length > 0
        ? "\n\nPAGES CREATED BY PREVIOUS BATCHES (reuse these, do NOT recreate):\n" +
          merged.new_pages
            .map(p => `- [${p.page_type}] ${p.slug} — ${p.description}${p.parent_hub ? ` (parentHub: ${p.parent_hub})` : ""}`)
            .join("\n")
        : "";

    const prompt = `You are the Cartographer of a personal wiki. Assign ${batch.length} facts to pages (batch ${batchIdx + 1}/${batches.length}).

═══════════════════════════════════════════════════════════
FUNDAMENTAL RULE: ONE FACT, ONE PAGE
═══════════════════════════════════════════════════════════
Each fact has EXACTLY ONE "home" page. Pages may reference each other via [[wikilinks]] but MUST NOT duplicate fact content. Choose the most semantically pertinent page for each fact.

═══════════════════════════════════════════════════════════
WIKI TOPOLOGY (2 livelli adattivi)
═══════════════════════════════════════════════════════════
- "person"        → leaf canonical da USERS.md (frodo, galadriel, gollum...). Contiene fatti owner_type=user di quella persona, e fatti che semanticamente vivono lì (es. preferenze personali, identità).
- "group_theme"   → hub-like canonical da USERS.md (famiglia, amici...). NON contiene fatti propri: agisce come hub di overview che linka i suoi child leaf. I fatti owner_type=group del suo scope vanno in concept_leaf separati sotto di esso.
- "concept_hub"   → hub tematico (può essere proposto da te). NON contiene fatti, solo overview narrativa di leaf figli. Crealo solo se serve raggruppare ≥2 concept_leaf semanticamente correlati.
- "concept_leaf"  → pagina di dettaglio tematica. Contiene fatti. Ha un parent_hub (concept_hub o group_theme).

═══════════════════════════════════════════════════════════
EXISTING FOUNDATION PAGES (immutable, da USERS.md)
═══════════════════════════════════════════════════════════
${foundationDesc}

═══════════════════════════════════════════════════════════
EXISTING CONCEPT PAGES (concept-registry, NON ricreare slug duplicati semanticamente)
═══════════════════════════════════════════════════════════
${registryDesc}${prevNewPages}

═══════════════════════════════════════════════════════════
ASSIGNMENT RULES
═══════════════════════════════════════════════════════════
1. owner_type="user"  → page_slug = pagina persona (foundation), SE il fatto è bio/preferenza/identità personale.
                        Altrimenti il fatto può andare su concept_leaf tematico (es. "il PC di Daniel" può andare su "tech_e_casa" se più pertinente).
2. owner_type="group" → page_slug = concept_leaf tematico sotto il group_theme corrispondente. NON metterlo direttamente sul group_theme (sono hub).
                        Se nessun concept_leaf adatto esiste, CREANE UNO NUOVO con parent_hub = il group_theme.
3. owner_type="global" → page_slug = concept_leaf tematico, eventualmente sotto un concept_hub.

REGOLE DURE:
- NON creare un nuovo slug se esiste già nel registry o nelle foundation pages — riusalo.
- NON creare nuovi concept_leaf se un concept_leaf esistente è semanticamente equivalente: assegna lì.
- I nomi nuovi devono essere in italiano, snake_case, descrittivi (es. "salute_routine_galadriel", "lavoro_progetti_frodo", NON "salute" generico se ce ne sono già).
- parent_hub di un concept_leaf deve essere un slug esistente (foundation group_theme, registry concept_hub) o un nuovo concept_hub che proponi nella stessa risposta.

═══════════════════════════════════════════════════════════
FACTS TO CLASSIFY
═══════════════════════════════════════════════════════════
${factLines}

═══════════════════════════════════════════════════════════
RESPONSE FORMAT (JSON, no markdown fence)
═══════════════════════════════════════════════════════════
{
  "assignments": [
    { "fact_id": "abc123", "page_slug": "frodo" },
    { "fact_id": "def456", "page_slug": "salute_routine_gollum" }
  ],
  "new_pages": [
    { "slug": "salute_routine_gollum", "title": "Routine medica di Daniel", "description": "Recupero post-operatorio e visite di controllo di Gollum", "page_type": "concept_leaf", "parent_hub": "famiglia" }
  ]
}`;

    let parsed: CartographerBlueprint | null = null;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await callLlmTask(api, prompt, "cartografo", 120000, "gemini-3-flash-preview", "minimal");
      try {
        let cleaned = response.trim();
        if (cleaned.startsWith("```json")) {
          cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
        } else if (cleaned.startsWith("```")) {
          cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
        }
        parsed = JSON.parse(cleaned);
        break;
      } catch (err) {
        logger.warn(`[Cartografo] Batch ${batchIdx + 1} attempt ${attempt}/${maxAttempts} JSON parse failed: ${err}`);
        if (attempt >= maxAttempts) {
          logger.error(`[Cartografo] Raw response:\n${response.substring(0, 500)}`);
          throw err;
        }
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (!parsed) throw new Error(`[Cartografo] Batch ${batchIdx + 1} returned null`);

    if (parsed.assignments) merged.assignments.push(...parsed.assignments);

    if (parsed.new_pages) {
      for (const np of parsed.new_pages) {
        const slug = np.slug.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        if (!knownSlugs.has(slug)) {
          knownSlugs.add(slug);
          merged.new_pages.push({ ...np, slug });
        }
      }
    }

    logger.info(
      `[Cartografo] Batch ${batchIdx + 1} done: ${parsed.assignments?.length || 0} assignments, ${parsed.new_pages?.length || 0} new_pages`
    );
  }

  logger.info(
    `[Cartografo] Totale: ${merged.assignments.length} assignments, ${merged.new_pages.length} new_pages proposte`
  );
  return merged;
}

// ---------------------------------------------------------------------------
// Stadio 1.5: Il Conciliatore (Gemini Pro, 1 call)
// ---------------------------------------------------------------------------

interface ConciliatorResult {
  redirects: Record<string, string>; // proposed_slug → existing_slug (merge)
  accepted_new: CartographerNewPage[];
}

/**
 * Verifica le new_pages proposte dal Cartografo contro il registry esistente.
 * Se una new_page è semanticamente equivalente a una pagina esistente, propone un redirect.
 * Si attiva SOLO se ci sono new_pages.
 */
async function conciliateNewPages(
  api: any,
  newPages: CartographerNewPage[],
  foundationPages: Record<string, PagePlan>,
  registry: ConceptRegistry,
  logger: any
): Promise<ConciliatorResult> {
  if (newPages.length === 0) {
    return { redirects: {}, accepted_new: [] };
  }

  const existingDesc = [
    ...Object.values(foundationPages).map(p => `- [${p.pageType}] ${p.slug} — ${p.title} | ${p.description}`),
    ...Object.values(registry.entries).map(e => `- [${e.pageType}] ${e.slug} — ${e.title} | ${e.description}`),
  ].join("\n");

  const newPagesDesc = newPages
    .map(p => `- [${p.page_type}] ${p.slug} — ${p.title} | ${p.description}${p.parent_hub ? ` (parentHub: ${p.parent_hub})` : ""}`)
    .join("\n");

  const prompt = `You are the Conciliator. The Cartographer proposed new wiki pages. Verify they are NOT semantic duplicates of existing pages.

═══════════════════════════════════════════════════════════
EXISTING PAGES (foundation + registry)
═══════════════════════════════════════════════════════════
${existingDesc}

═══════════════════════════════════════════════════════════
PROPOSED NEW PAGES
═══════════════════════════════════════════════════════════
${newPagesDesc}

═══════════════════════════════════════════════════════════
TASK
═══════════════════════════════════════════════════════════
For each proposed new page:
- If it is semantically equivalent (same topic, even with a different slug like "sport" vs "sport_e_tempo_libero", or "salute" vs "salute_e_benessere") to an EXISTING page → put it in "redirects" mapping the proposed slug to the existing slug.
- If it is genuinely a new topic → put it in "accepted_new" preserving slug, title, description, page_type, parent_hub.

REGOLE:
- Slug "sport" e "sport_e_tempo_libero" sono semanticamente lo stesso topic → SEMPRE redirect.
- Slug "salute" e "salute_e_benessere" stesso topic → SEMPRE redirect.
- Slug specifici come "salute_routine_gollum" vs "salute_emergenze_galadriel" sono DIVERSI (diversa persona, diverso aspetto).
- In caso di dubbio favorisci il redirect (consolidamento) — meglio meno pagine ben popolate che molte sparse.

═══════════════════════════════════════════════════════════
RESPONSE FORMAT (JSON, no markdown fence)
═══════════════════════════════════════════════════════════
{
  "redirects": {
    "sport_e_tempo_libero": "sport"
  },
  "accepted_new": [
    { "slug": "salute_routine_gollum", "title": "...", "description": "...", "page_type": "concept_leaf", "parent_hub": "famiglia" }
  ]
}`;

  logger.info(`[Conciliatore] Checking ${newPages.length} proposed new pages against ${Object.keys(registry.entries).length + Object.keys(foundationPages).length} existing...`);

  let parsed: ConciliatorResult | null = null;
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await callLlmTask(api, prompt, "conciliatore", 120000, "gemini-3.1-pro-preview", "low");
      let cleaned = response.trim();
      if (cleaned.startsWith("```json")) {
        cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
      } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
      }
      parsed = JSON.parse(cleaned);
      break;
    } catch (err) {
      logger.warn(`[Conciliatore] Attempt ${attempt}/${maxAttempts} failed: ${err}`);
      if (attempt >= maxAttempts) {
        logger.error(`[Conciliatore] Falling back: accepting all new_pages without merge`);
        return { redirects: {}, accepted_new: newPages };
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  if (!parsed) {
    return { redirects: {}, accepted_new: newPages };
  }

  // Sanity: ensure accepted_new is an array
  if (!Array.isArray(parsed.accepted_new)) parsed.accepted_new = [];
  if (!parsed.redirects || typeof parsed.redirects !== "object") parsed.redirects = {};

  logger.info(
    `[Conciliatore] ${Object.keys(parsed.redirects).length} redirects, ${parsed.accepted_new.length} new accepted`
  );
  return parsed;
}

// ---------------------------------------------------------------------------
// Stadio 2: L'Architetto (deterministic)
// ---------------------------------------------------------------------------

function buildCompilationPlan(
  allFacts: Fact[],
  foundationPages: Record<string, PagePlan>,
  blueprint: CartographerBlueprint,
  conciliation: ConciliatorResult,
  registry: ConceptRegistry,
  groupScopes: Record<string, string[]>,
  logger: any
): { plan: CompilationPlan; updatedRegistry: ConceptRegistry } {
  const pages: Record<string, PagePlan> = {};
  for (const [slug, p] of Object.entries(foundationPages)) {
    pages[slug] = { ...p, primaryFacts: [], referencedFacts: [], childLeaves: [] };
  }

  // Materialize concept pages from registry (preserved across REM)
  for (const [slug, entry] of Object.entries(registry.entries)) {
    if (pages[slug]) continue; // foundation overrides
    pages[slug] = {
      slug,
      title: entry.title,
      description: entry.description,
      pageType: entry.pageType,
      parentHub: entry.parentHub,
      childLeaves: [],
      primaryFacts: [],
      referencedFacts: [],
      outgoingLinks: [],
      incomingLinks: [],
    };
  }

  // Materialize new accepted concept pages from this run
  const updatedRegistry: ConceptRegistry = {
    version: REGISTRY_VERSION,
    entries: { ...registry.entries },
    generatedAt: new Date().toISOString(),
  };
  for (const np of conciliation.accepted_new) {
    const slug = np.slug.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (pages[slug]) continue; // already exists
    pages[slug] = {
      slug,
      title: np.title,
      description: np.description,
      pageType: np.page_type,
      parentHub: np.parent_hub,
      childLeaves: [],
      primaryFacts: [],
      referencedFacts: [],
      outgoingLinks: [],
      incomingLinks: [],
    };
    updatedRegistry.entries[slug] = {
      slug,
      title: np.title,
      description: np.description,
      pageType: np.page_type,
      parentHub: np.parent_hub,
      aliases: [],
      createdAt: new Date().toISOString(),
    };
    dlog(`Architect: created new ${np.page_type} "${slug}" parent=${np.parent_hub || "—"}`);
  }

  // Build fact lookup
  const factMap = new Map<string, Fact>();
  for (const f of allFacts) factMap.set(f.id, f);

  // Apply assignments — un fatto, una pagina (tenendo conto dei redirect)
  const assignedFactIds = new Set<string>();
  for (const a of blueprint.assignments) {
    const fact = factMap.get(a.fact_id);
    if (!fact) {
      dlog(`Architect: fact ${a.fact_id} not in DB (likely superseded), skip`);
      continue;
    }
    let slug = a.page_slug.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    // Apply redirects
    if (conciliation.redirects[slug]) {
      slug = conciliation.redirects[slug];
    }

    if (!pages[slug]) {
      // Fallback: create on-the-fly as concept_leaf
      logger.warn(`[Architetto] page "${slug}" not materialized, creating fallback concept_leaf`);
      pages[slug] = {
        slug,
        title: slug.charAt(0).toUpperCase() + slug.slice(1).replace(/_/g, " "),
        description: "",
        pageType: "concept_leaf",
        childLeaves: [],
        primaryFacts: [],
        referencedFacts: [],
        outgoingLinks: [],
        incomingLinks: [],
      };
      updatedRegistry.entries[slug] = {
        slug,
        title: pages[slug].title,
        description: "",
        pageType: "concept_leaf",
        aliases: [],
        createdAt: new Date().toISOString(),
      };
    }

    pages[slug].primaryFacts.push({
      id: fact.id,
      text: fact.text,
      factType: fact.fact_type,
      ownerType: fact.owner_type,
      ownerId: fact.owner_id,
      senderId: fact.sender_id,
    });
    assignedFactIds.add(fact.id);
  }

  // Orphan facts (no assignment) → fallback to owner page
  const orphans = allFacts.filter(f => !assignedFactIds.has(f.id));
  if (orphans.length > 0) {
    logger.warn(`[Architetto] ${orphans.length} orphan facts, fallback to owner page`);
    for (const f of orphans) {
      const ownerSlug = (f.owner_id || "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
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

  // Compute parent-child relationships
  // group_theme and concept_hub act as hubs; person and concept_leaf can have parentHub
  const mergedPages: { from: string; into: string; reason: string }[] = [];
  const pagesToRemove: string[] = [];

  for (const [slug, page] of Object.entries(pages)) {
    if (page.parentHub && pages[page.parentHub]) {
      const parent = pages[page.parentHub];
      if (!parent.childLeaves.includes(slug)) {
        parent.childLeaves.push(slug);
      }
    }
  }

  // Garbage collection: concept_leaf with 0 facts and no children → mark for removal
  // concept_hub with 0 children → also remove (empty hub)
  for (const [slug, page] of Object.entries(pages)) {
    if (page.pageType === "person" || page.pageType === "group_theme") continue; // foundation pages stay

    if (page.pageType === "concept_leaf" && page.primaryFacts.length === 0) {
      pagesToRemove.push(slug);
      mergedPages.push({ from: slug, into: page.parentHub || "—", reason: "concept_leaf con 0 fatti" });
      dlog(`Architect: removing empty concept_leaf "${slug}"`);
    } else if (page.pageType === "concept_hub" && page.childLeaves.length === 0) {
      pagesToRemove.push(slug);
      mergedPages.push({ from: slug, into: "—", reason: "concept_hub senza children" });
      dlog(`Architect: removing empty concept_hub "${slug}"`);
    }
  }

  for (const slug of pagesToRemove) {
    // Remove from parent's childLeaves
    const page = pages[slug];
    if (page?.parentHub && pages[page.parentHub]) {
      pages[page.parentHub].childLeaves = pages[page.parentHub].childLeaves.filter(s => s !== slug);
    }
    delete pages[slug];
    delete updatedRegistry.entries[slug];
  }

  // Build link graph
  const linkGraph: Record<string, string[]> = {};

  // Hub → child leaves (outgoing)
  for (const [slug, page] of Object.entries(pages)) {
    if (!linkGraph[slug]) linkGraph[slug] = [];
    for (const child of page.childLeaves) {
      if (pages[child] && !linkGraph[slug].includes(child)) {
        linkGraph[slug].push(child);
      }
    }
    // Foundation outgoing links (relations between persons, group memberships)
    for (const link of page.outgoingLinks) {
      if (pages[link] && !linkGraph[slug].includes(link) && link !== slug) {
        linkGraph[slug].push(link);
      }
    }
  }

  // Make symmetric (bidirectional)
  for (const [slug, links] of Object.entries(linkGraph)) {
    for (const target of links) {
      if (!linkGraph[target]) linkGraph[target] = [];
      if (!linkGraph[target].includes(slug)) {
        linkGraph[target].push(slug);
      }
    }
  }

  // Sync onto pages
  for (const [slug, page] of Object.entries(pages)) {
    page.outgoingLinks = linkGraph[slug] || [];
    page.incomingLinks = Object.entries(linkGraph)
      .filter(([_, targets]) => targets.includes(slug))
      .map(([source]) => source);
  }

  // Compilation order: hubs first (group_theme + concept_hub), then leaves
  const compilationOrder = Object.values(pages)
    .sort((a, b) => {
      const order = { group_theme: 0, concept_hub: 1, person: 2, concept_leaf: 3 };
      return (order[a.pageType] ?? 4) - (order[b.pageType] ?? 4);
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
    dirtyPages: compilationOrder, // overridden by computeDirtyPages caller
  };

  logger.info(
    `[Architetto] Plan: ${compilationOrder.length} pages (${mergedPages.length} removed), order: ${compilationOrder.join(" → ")}`
  );
  return { plan, updatedRegistry };
}

// ---------------------------------------------------------------------------
// Incremental helpers
// ---------------------------------------------------------------------------

function loadPreviousPlan(config: PluginConfig, logger: any): CompilationPlan | null {
  const planPath = path.join(config.wikiPath, "_meta", "compilation-plan.json");
  try {
    if (!fs.existsSync(planPath)) return null;
    const raw = fs.readFileSync(planPath, "utf-8");
    const plan = JSON.parse(raw) as CompilationPlan;
    if (!plan.pages || !plan.compilationOrder) return null;
    return plan;
  } catch (e) {
    logger.warn(`[Wiki Planner] Could not load previous plan: ${e}`);
    return null;
  }
}

function extractAssignedFactIds(plan: CompilationPlan): Map<string, string> {
  const map = new Map<string, string>();
  for (const [slug, page] of Object.entries(plan.pages)) {
    for (const f of page.primaryFacts) {
      map.set(f.id, slug);
    }
  }
  return map;
}

/**
 * Fingerprint che include fatti + outgoing links + parentHub + childLeaves.
 * Garantisce che pagine la cui "topologia" cambia (anche senza nuovi fatti)
 * vengano marcate dirty. Risolve il problema della propagazione link.
 */
function pageFingerprint(p: PagePlan): string {
  const factIds = p.primaryFacts.map(f => f.id).sort().join(",");
  const out = [...p.outgoingLinks].sort().join(",");
  const children = [...p.childLeaves].sort().join(",");
  return `${factIds}|${out}|${p.parentHub || ""}|${children}`;
}

function computeDirtyPages(prev: CompilationPlan, next: CompilationPlan): string[] {
  const dirty = new Set<string>();
  const prevFP = new Map<string, string>();
  for (const [s, p] of Object.entries(prev.pages)) prevFP.set(s, pageFingerprint(p));
  const nextFP = new Map<string, string>();
  for (const [s, p] of Object.entries(next.pages)) nextFP.set(s, pageFingerprint(p));

  for (const [s, fp] of nextFP) {
    if (!prevFP.has(s) || prevFP.get(s) !== fp) dirty.add(s);
  }
  for (const s of prevFP.keys()) {
    if (!nextFP.has(s)) dirty.add(s); // removed pages need cleanup
  }
  return Array.from(dirty);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Esegue la pipeline Stadi 0 → 0.5 → 1 → 1.5 → 2.
 * Modalità incrementale: classifica solo i fatti nuovi, riusa registry e plan.
 */
export async function buildWikiPlan(
  api: any,
  db: Database.Database,
  config: PluginConfig,
  logger: any
): Promise<CompilationPlan> {
  const allFacts = db
    .prepare(`SELECT * FROM facts WHERE is_active = 1 ORDER BY fact_type, updated_at DESC`)
    .all() as Fact[];

  if (allFacts.length === 0) {
    logger.warn("[Wiki Planner] No active facts, skeleton-only plan");
  }

  // Stadio 0: Fonditore
  logger.info("[Wiki Planner] === Stadio 0: Il Fonditore ===");
  const { pages: foundationPages, groupScopes } = buildFoundationPages(db, logger);

  // Stadio 0.5: Topology Seed (load registry)
  logger.info("[Wiki Planner] === Stadio 0.5: Topology Seed ===");
  const registry = loadConceptRegistry(config, logger);
  logger.info(`[Topology Seed] Loaded ${Object.keys(registry.entries).length} concept pages from registry`);

  // Incremental: classify only new facts
  const prevPlan = loadPreviousPlan(config, logger);
  const currentFactIds = new Set(allFacts.map(f => f.id));

  let blueprint: CartographerBlueprint = { assignments: [], new_pages: [] };

  if (prevPlan && allFacts.length > 0) {
    const prevAssigned = extractAssignedFactIds(prevPlan);
    const newFacts = allFacts.filter(f => !prevAssigned.has(f.id));
    const removedFactIds = Array.from(prevAssigned.keys()).filter(id => !currentFactIds.has(id));

    if (newFacts.length === 0 && removedFactIds.length === 0) {
      logger.info(`[Wiki Planner] === Stadio 1+ (SKIPPED — 0 new, 0 removed) ===`);
      const reused: CompilationPlan = { ...prevPlan, generatedAt: new Date().toISOString(), dirtyPages: [] };
      const planPath = path.join(config.wikiPath, "_meta", "compilation-plan.json");
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      fs.writeFileSync(planPath, JSON.stringify(reused, null, 2), "utf-8");
      return reused;
    }

    logger.info(`[Wiki Planner] === Stadio 1: Cartografo (INCREMENTAL — ${newFacts.length} new, ${removedFactIds.length} removed) ===`);

    // Carry over old assignments (filtering removed facts)
    for (const [slug, page] of Object.entries(prevPlan.pages)) {
      for (const f of page.primaryFacts) {
        if (currentFactIds.has(f.id)) {
          blueprint.assignments.push({ fact_id: f.id, page_slug: slug });
        }
      }
    }

    // Classify only new facts
    if (newFacts.length > 0) {
      const newBlueprint = await classifyFacts(api, newFacts, foundationPages, registry, logger);
      blueprint.assignments.push(...newBlueprint.assignments);
      blueprint.new_pages.push(...newBlueprint.new_pages);
    }
  } else if (allFacts.length > 0) {
    logger.info("[Wiki Planner] === Stadio 1: Cartografo (FULL — no previous plan) ===");
    blueprint = await classifyFacts(api, allFacts, foundationPages, registry, logger);
  }

  // Stadio 1.5: Conciliatore — only if Cartographer proposed new_pages
  let conciliation: ConciliatorResult = { redirects: {}, accepted_new: [] };
  if (blueprint.new_pages.length > 0) {
    logger.info(`[Wiki Planner] === Stadio 1.5: Conciliatore (${blueprint.new_pages.length} new pages to verify) ===`);
    conciliation = await conciliateNewPages(api, blueprint.new_pages, foundationPages, registry, logger);

    // Apply redirects to assignments
    if (Object.keys(conciliation.redirects).length > 0) {
      blueprint.assignments = blueprint.assignments.map(a => {
        const slug = a.page_slug.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        return conciliation.redirects[slug] ? { ...a, page_slug: conciliation.redirects[slug] } : a;
      });
    }
  } else {
    logger.info(`[Wiki Planner] === Stadio 1.5: Conciliatore (SKIPPED — no new pages) ===`);
  }

  // Stadio 2: L'Architetto
  logger.info("[Wiki Planner] === Stadio 2: L'Architetto ===");
  const { plan, updatedRegistry } = buildCompilationPlan(
    allFacts,
    foundationPages,
    blueprint,
    conciliation,
    registry,
    groupScopes,
    logger
  );

  // Compute dirty pages
  if (prevPlan) {
    plan.dirtyPages = computeDirtyPages(prevPlan, plan);
    logger.info(
      `[Wiki Planner] Dirty pages: ${plan.dirtyPages.length}/${plan.compilationOrder.length} (${plan.dirtyPages.join(", ") || "none"})`
    );
  } else {
    plan.dirtyPages = [...plan.compilationOrder];
  }

  // Persist plan + updated registry
  const planPath = path.join(config.wikiPath, "_meta", "compilation-plan.json");
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
  saveConceptRegistry(config, updatedRegistry);
  dlog(`Plan saved to ${planPath}`);

  return plan;
}
