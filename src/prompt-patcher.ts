/**
 * prompt-patcher.ts — Declarative system prompt modification
 *
 * Reads a JSON patch file and applies modifications (removals + replacements)
 * to the OpenClaw system prompt. Loaded via pluginConfig.promptPatchesFile.
 *
 * Patch types:
 *   - remove (type: "section"): removes from "## Heading" to the next "## " or end-of-prompt
 *   - replace: exact string replacement
 *
 * Design: ADR-020, multiuser_design.md v6
 */

import * as fs from "fs";
import { dbg } from "./debug";

const dlog = dbg("prompt-patcher");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemovePatch {
  id: string;
  description?: string;
  match: string;
  type: "section";
}

export interface ReplacePatch {
  id: string;
  description?: string;
  target: string;
  replacement: string;
}

export interface PatchFile {
  remove?: RemovePatch[];
  replace?: ReplacePatch[];
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let cachedPatches: PatchFile | null = null;
let cachedPatchesMtime: number = 0;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load the patch file from disk. Caches by mtime to avoid re-reading
 * on every prompt build.
 */
function loadPatches(patchesPath: string): PatchFile {
  try {
    const stat = fs.statSync(patchesPath);
    if (cachedPatches && stat.mtimeMs === cachedPatchesMtime) {
      return cachedPatches;
    }
    const raw = fs.readFileSync(patchesPath, "utf-8");
    cachedPatches = JSON.parse(raw);
    cachedPatchesMtime = stat.mtimeMs;
    dlog(`[patcher] Loaded ${cachedPatches!.remove?.length ?? 0} removals + ${cachedPatches!.replace?.length ?? 0} replacements from ${patchesPath}`);
    return cachedPatches!;
  } catch (e) {
    dlog(`[patcher] Failed to load patches from ${patchesPath}: ${e}`);
    return { remove: [], replace: [] };
  }
}

// ---------------------------------------------------------------------------
// Patcher
// ---------------------------------------------------------------------------

/**
 * Apply prompt patches to the given system prompt text.
 *
 * @param prompt — the full system prompt text from event.prompt
 * @param patchesPath — absolute path to the prompt-patches.json file
 * @returns — the patched prompt text
 */
export function applyPromptPatches(prompt: string, patchesPath: string): string {
  const patches = loadPatches(patchesPath);
  let result = prompt;
  let appliedCount = 0;

  // 1. Replace: exact string substitution
  for (const r of patches.replace ?? []) {
    if (result.includes(r.target)) {
      result = result.replace(r.target, r.replacement);
      appliedCount++;
      dlog(`[patcher] Applied replace: ${r.id}`);
    } else {
      dlog(`[patcher] SKIP replace (not found): ${r.id} — target: "${r.target.substring(0, 60)}..."`);
    }
  }

  // 2. Remove: section removal (from "## Heading" to next "## " or end-of-string)
  for (const s of patches.remove ?? []) {
    if (s.type === "section") {
      const escaped = s.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Match the heading line + everything until the next "## " heading or end of string
      const regex = new RegExp(escaped + "[\\s\\S]*?(?=\\n## |$)", "g");
      const before = result.length;
      result = result.replace(regex, "");
      if (result.length < before) {
        appliedCount++;
        dlog(`[patcher] Applied section removal: ${s.id} (removed ${before - result.length} chars)`);
      } else {
        dlog(`[patcher] SKIP removal (not found): ${s.id} — match: "${s.match}"`);
      }
    }
  }

  // Clean up excessive newlines from removals
  result = result.replace(/\n{3,}/g, "\n\n");

  dlog(`[patcher] ${appliedCount} patches applied`);
  return result;
}
