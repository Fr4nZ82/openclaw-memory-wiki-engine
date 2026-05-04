/**
 * utils.ts — Pure utility functions
 *
 * Extracted from db.ts to break the transitive dependency on better-sqlite3.
 * These functions are used across many modules but have zero DB dependencies.
 */

/**
 * Generates a unique ID for a fact.
 * Format: f_<timestamp>_<random>
 */
export function generateFactId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `f_${ts}_${rand}`;
}

/**
 * Converts a topics array to JSON string for DB storage.
 */
export function topicsToJson(topics: string[]): string {
  return JSON.stringify(topics);
}

/**
 * Converts a JSON topics string to array.
 */
export function jsonToTopics(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [json]; // fallback: treat as single topic
  }
}

/**
 * Keyword guard for dedup and supersedence.
 *
 * Extracts "distinctive" words from both texts (words present in one
 * but not the other) and checks if they contain substantive nouns
 * (words > 4 chars that aren't stop words).
 * If both sides have distinctive substantive words, the facts likely
 * describe different things despite high embedding similarity.
 *
 * Example:
 *   "Daniel frequenta Karate il lunedì" vs "Daniel frequenta Breakdance il mercoledì"
 *   → distinctive words A: {karate, lunedì}, B: {breakdance, mercoledì}
 *   → both have substantive distinctive words → returns true (block dedup)
 *
 *   "Daniel fa karate" vs "Daniel faceva karate"
 *   → distinctive words A: {fa}, B: {faceva}
 *   → no substantive distinctive words → returns false (allow dedup)
 */
export function hasDistinctiveKeywordDifference(
  textA: string,
  textB: string
): boolean {
  const stopWords = new Set([
    "il", "lo", "la", "i", "gli", "le", "un", "uno", "una",
    "di", "a", "da", "in", "con", "su", "per", "tra", "fra",
    "che", "non", "è", "ha", "sono", "come", "anche", "più",
    "del", "della", "dei", "delle", "dello", "degli", "nel",
    "nella", "nei", "nelle", "nello", "negli", "al", "alla",
    "ai", "alle", "allo", "agli", "dal", "dalla", "dai",
    "dalle", "dallo", "dagli", "sul", "sulla", "sui", "sulle",
    "the", "a", "an", "is", "are", "was", "of", "to", "and",
    "for", "in", "on", "at", "by", "with", "alle", "dalle",
  ]);

  const wordsA = new Set(
    textA.toLowerCase().replace(/[^a-zà-ú0-9\s]/gi, "").split(/\s+/).filter(w => w.length > 1)
  );
  const wordsB = new Set(
    textB.toLowerCase().replace(/[^a-zà-ú0-9\s]/gi, "").split(/\s+/).filter(w => w.length > 1)
  );

  // Words unique to A and unique to B
  const onlyA = [...wordsA].filter(w => !wordsB.has(w) && !stopWords.has(w));
  const onlyB = [...wordsB].filter(w => !wordsA.has(w) && !stopWords.has(w));

  // Substantive = word length > 4 (filters out verb conjugations, articles, short prepositions)
  const substantiveA = onlyA.filter(w => w.length > 4);
  const substantiveB = onlyB.filter(w => w.length > 4);

  // If BOTH sides have substantive distinctive words, they're likely about different things
  return substantiveA.length > 0 && substantiveB.length > 0;
}
