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
