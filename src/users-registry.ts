/**
 * users-registry.ts — USERS.md parser, DB sync, and prompt context builder
 *
 * Parses the workspace USERS.md file (Single Source of Truth for user identity,
 * groups, permissions, and behavioral profiles) and provides:
 *
 *   1. parseUsersFile()     — parse USERS.md into structured data
 *   2. syncUsersToDb()      — idempotent sync: USERS.md → DB (users, user_groups, group_members)
 *   3. buildUsersContext()  — build <users_context> XML block for prompt injection
 *   4. isAdminMember()      — check if a sender_id belongs to the 'admin' group
 *   5. getUserProfile()     — get parsed profile for a specific sender
 *
 * Design: ADR-020, multiuser_design.md v6
 */

import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { dbg } from "./debug";

const dlog = dbg("users-registry");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedGroup {
  id: string;
  description: string;
  permissions: string[];
  scope: string[];
}

export interface ParsedUser {
  slug: string;
  sender_id: string;
  channel: string;
  aliases: string[];
  groups: string[];
  relazioni: string;
  restrictions: string[];
  born: string;
  profile: string;
}

export interface UsersRegistry {
  groups: ParsedGroup[];
  users: ParsedUser[];
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let cachedRegistry: UsersRegistry | null = null;
let cachedMtime: number = 0;

/**
 * Get the cached registry, or null if not loaded yet.
 * Used by other modules that need user info without re-parsing.
 */
export function getCachedRegistry(): UsersRegistry | null {
  return cachedRegistry;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse USERS.md from the given path.
 * Returns structured groups and users.
 *
 * File format:
 *   # USERS
 *   ## Gruppi
 *     ### <group_slug>
 *     - permissions: csv
 *     - description: text
 *     - scope: text; text; text
 *   ---
 *   ## <user_slug>
 *   - sender_id: value
 *   - aliases: csv
 *   - groups: csv
 *   - channel: value
 *   - relazioni: free-form
 *   - restrictions: csv
 *   - born: date
 *   ### Profilo
 *   <multi-line text>
 */
export function parseUsersFile(filePath: string): UsersRegistry {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/);

  const groups: ParsedGroup[] = [];
  const users: ParsedUser[] = [];

  let inGroupsSection = false;
  let currentGroup: ParsedGroup | null = null;
  let currentUser: ParsedUser | null = null;
  let inProfile = false;
  let profileLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // --- separators (between user entries)
    if (trimmed === "---") {
      // Flush current user profile if any
      if (currentUser && inProfile) {
        currentUser.profile = profileLines.join("\n").trim();
        inProfile = false;
        profileLines = [];
      }
      if (currentUser) {
        users.push(currentUser);
        currentUser = null;
      }
      if (currentGroup) {
        groups.push(currentGroup);
        currentGroup = null;
      }
      continue;
    }

    // ## Gruppi — start of groups section
    if (/^## Gruppi\s*$/i.test(trimmed)) {
      inGroupsSection = true;
      continue;
    }

    // ### <group_slug> inside Gruppi
    if (inGroupsSection && /^### (.+)$/.test(trimmed)) {
      if (currentGroup) groups.push(currentGroup);
      const slug = trimmed.replace(/^### /, "").trim().toLowerCase();
      currentGroup = { id: slug, description: "", permissions: [], scope: [] };
      continue;
    }

    // ## <user_slug> — start of a user entry (any H2 except "Gruppi" and top-level "USERS")
    if (/^## (.+)$/.test(trimmed) && !inGroupsSection) {
      // Flush previous user
      if (currentUser && inProfile) {
        currentUser.profile = profileLines.join("\n").trim();
        inProfile = false;
        profileLines = [];
      }
      if (currentUser) users.push(currentUser);

      const slug = trimmed.replace(/^## /, "").trim().toLowerCase();
      if (slug === "users" || slug === "gruppi") continue;

      currentUser = {
        slug,
        sender_id: "",
        channel: "",
        aliases: [],
        groups: [],
        relazioni: "",
        restrictions: [],
        born: "",
        profile: "",
      };
      inProfile = false;
      continue;
    }

    // Detect end of Gruppi section: any H2 that isn't a group starts user area
    if (inGroupsSection && /^## (.+)$/.test(trimmed)) {
      if (currentGroup) {
        groups.push(currentGroup);
        currentGroup = null;
      }
      inGroupsSection = false;
      // Re-process this line as a user H2
      const slug = trimmed.replace(/^## /, "").trim().toLowerCase();
      if (slug !== "users" && slug !== "gruppi") {
        currentUser = {
          slug,
          sender_id: "",
          channel: "",
          aliases: [],
          groups: [],
          relazioni: "",
          restrictions: [],
          born: "",
          profile: "",
        };
      }
      continue;
    }

    // ### Profilo — start of profile section
    if (currentUser && /^### Profilo\s*$/i.test(trimmed)) {
      inProfile = true;
      profileLines = [];
      continue;
    }

    // Multi-line profile content
    if (currentUser && inProfile) {
      profileLines.push(line);
      continue;
    }

    // Bullet properties for groups
    if (currentGroup && /^- /.test(trimmed)) {
      const match = trimmed.match(/^- (\w+):\s*(.*)$/);
      if (match) {
        const [, key, value] = match;
        switch (key.toLowerCase()) {
          case "permissions":
            currentGroup.permissions = value.split(",").map(s => s.trim()).filter(Boolean);
            break;
          case "description":
            currentGroup.description = value;
            break;
          case "scope":
            currentGroup.scope = value.split(";").map(s => s.trim()).filter(Boolean);
            break;
        }
      }
      continue;
    }

    // Bullet properties for users
    if (currentUser && !inProfile && /^- /.test(trimmed)) {
      const match = trimmed.match(/^- (\w+):\s*(.*)$/);
      if (match) {
        const [, key, value] = match;
        switch (key.toLowerCase()) {
          case "sender_id":
            currentUser.sender_id = value.trim();
            break;
          case "channel":
            currentUser.channel = value.trim();
            break;
          case "aliases":
            currentUser.aliases = value.split(",").map(s => s.trim()).filter(Boolean);
            break;
          case "groups":
            currentUser.groups = value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
            break;
          case "relazioni":
            currentUser.relazioni = value.trim();
            break;
          case "restrictions":
            currentUser.restrictions = value.split(",").map(s => s.trim()).filter(Boolean);
            break;
          case "born":
            currentUser.born = value.trim();
            break;
        }
      }
      continue;
    }
  }

  // Flush last entries
  if (currentUser && inProfile) {
    currentUser.profile = profileLines.join("\n").trim();
  }
  if (currentUser) users.push(currentUser);
  if (currentGroup) groups.push(currentGroup);

  const registry: UsersRegistry = { groups, users };
  cachedRegistry = registry;
  return registry;
}

/**
 * Load and cache the registry. Re-parses only if the file was modified since
 * the last parse (mtime check).
 */
export function loadRegistry(filePath: string): UsersRegistry {
  try {
    const stat = fs.statSync(filePath);
    if (cachedRegistry && stat.mtimeMs === cachedMtime) {
      return cachedRegistry;
    }
    cachedMtime = stat.mtimeMs;
    return parseUsersFile(filePath);
  } catch (e) {
    dlog(`Failed to load USERS.md from ${filePath}: ${e}`);
    return cachedRegistry ?? { groups: [], users: [] };
  }
}

// ---------------------------------------------------------------------------
// DB Sync
// ---------------------------------------------------------------------------

/**
 * Sync USERS.md data to the DB tables (users, user_groups, group_members).
 * Idempotent: INSERT OR REPLACE + cleanup of stale entries.
 */
export function syncUsersToDb(db: Database.Database, registry: UsersRegistry): void {
  const syncTxn = db.transaction(() => {
    // 1. Sync groups → user_groups
    const upsertGroup = db.prepare(
      `INSERT OR REPLACE INTO user_groups (id, name, description, scope) VALUES (?, ?, ?, ?)`
    );
    const registryGroupIds = new Set<string>();
    for (const g of registry.groups) {
      registryGroupIds.add(g.id);
      upsertGroup.run(
        g.id,
        g.id.charAt(0).toUpperCase() + g.id.slice(1), // Capitalize name
        g.description || null,
        g.scope.length > 0 ? JSON.stringify(g.scope) : null
      );
    }

    // 2. Sync users → users table
    const upsertUser = db.prepare(
      `INSERT OR REPLACE INTO users (sender_id, names) VALUES (?, ?)`
    );
    const registrySenderIds = new Set<string>();
    for (const u of registry.users) {
      registrySenderIds.add(u.sender_id);
      const names = [u.slug.charAt(0).toUpperCase() + u.slug.slice(1), ...u.aliases];
      upsertUser.run(u.sender_id, JSON.stringify(names));
    }

    // 3. Sync memberships → group_members
    //    Clear all memberships first, then re-insert from USERS.md (idempotent)
    db.prepare(`DELETE FROM group_members`).run();
    const insertMember = db.prepare(
      `INSERT OR IGNORE INTO group_members (group_id, sender_id) VALUES (?, ?)`
    );
    for (const u of registry.users) {
      for (const groupId of u.groups) {
        // Ensure the group exists (even if not explicitly defined in ## Gruppi)
        if (!registryGroupIds.has(groupId)) {
          upsertGroup.run(groupId, groupId.charAt(0).toUpperCase() + groupId.slice(1), null, null);
          registryGroupIds.add(groupId);
        }
        insertMember.run(groupId, u.sender_id);
      }
    }

    // 4. Cleanup: remove users in DB but not in USERS.md
    const dbUsers = db.prepare(`SELECT sender_id FROM users`).all() as { sender_id: string }[];
    const deleteUser = db.prepare(`DELETE FROM users WHERE sender_id = ?`);
    for (const row of dbUsers) {
      if (!registrySenderIds.has(row.sender_id)) {
        deleteUser.run(row.sender_id);
        dlog(`[sync] Removed stale user: ${row.sender_id}`);
      }
    }

    // 5. Cleanup: remove groups in DB but not in USERS.md
    const dbGroups = db.prepare(`SELECT id FROM user_groups`).all() as { id: string }[];
    const deleteGroup = db.prepare(`DELETE FROM user_groups WHERE id = ?`);
    for (const row of dbGroups) {
      if (!registryGroupIds.has(row.id)) {
        deleteGroup.run(row.id);
        dlog(`[sync] Removed stale group: ${row.id}`);
      }
    }
  });

  syncTxn();

  dlog(`[sync] ${registry.users.length} users, ${registry.groups.length} groups, ` +
    `${registry.users.reduce((n, u) => n + u.groups.length, 0)} memberships synced from USERS.md`);
}

// ---------------------------------------------------------------------------
// Prompt context builder
// ---------------------------------------------------------------------------

/**
 * Build the <users_context> XML block for injection into the system prompt.
 *
 * Contains:
 *   - <known_users>: roster of all users (slug, aliases, groups, relazioni)
 *   - <current_user>: private profile of the current sender (permissions, restrictions, profile text)
 *
 * If senderId is unknown, injects a guest/unknown profile with minimal permissions.
 */
export function buildUsersContext(registry: UsersRegistry, senderId: string): string {
  // Build roster
  const rosterLines: string[] = [];
  for (const u of registry.users) {
    const attrs: string[] = [`slug="${u.slug}"`];
    if (u.aliases.length > 0) attrs.push(`aliases="${u.aliases.join(", ")}"`);
    if (u.groups.length > 0) attrs.push(`groups="${u.groups.join(", ")}"`);
    if (u.relazioni) attrs.push(`relazioni="${u.relazioni}"`);
    rosterLines.push(`    <user ${attrs.join(" ")} />`);
  }

  // Find current user
  const currentUser = registry.users.find(u => u.sender_id === senderId);

  let currentUserBlock: string;
  if (currentUser) {
    // Resolve permissions from groups
    const userGroups = currentUser.groups;
    const groupPerms = new Set<string>();
    for (const gid of userGroups) {
      const group = registry.groups.find(g => g.id === gid);
      if (group) {
        for (const p of group.permissions) groupPerms.add(p);
      }
    }

    const parts: string[] = [];
    parts.push(`  <current_user slug="${currentUser.slug}" groups="${userGroups.join(", ")}">`);
    if (groupPerms.size > 0) {
      parts.push(`    <permissions>${[...groupPerms].join(", ")}</permissions>`);
    }
    if (currentUser.restrictions.length > 0) {
      parts.push(`    <restrictions>${currentUser.restrictions.join(", ")}</restrictions>`);
    }
    if (currentUser.profile) {
      parts.push(`    <profile>`);
      parts.push(currentUser.profile);
      parts.push(`    </profile>`);
    }
    parts.push(`  </current_user>`);
    currentUserBlock = parts.join("\n");
  } else {
    // Unknown sender — guest profile
    currentUserBlock = [
      `  <current_user slug="unknown" groups="guest" sender_id="${senderId}">`,
      `    <permissions>chat</permissions>`,
      `    <restrictions>no_exec, no_system, no_gateway, no_cron, no_gandalf, no_agents</restrictions>`,
      `    <profile>Utente sconosciuto. Rispondi cortesemente, nessuna azione di sistema.</profile>`,
      `  </current_user>`,
    ].join("\n");
  }

  return [
    `<users_context>`,
    `  <known_users>`,
    ...rosterLines,
    `  </known_users>`,
    currentUserBlock,
    `</users_context>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Multi-User Mode directive (static text)
// ---------------------------------------------------------------------------

export const MULTI_USER_DIRECTIVE = `## Multi-User Mode
You serve multiple users with different permission levels.
- <users_context> contains a roster of known users and the current user's private profile.
- Use the roster to disambiguate names (e.g., "Galadriel" is a user, not the LOTR character).
- Enforce the current user's permissions and restrictions strictly.
- If a user requests something beyond their permissions, decline and offer to notify an admin.
- Unknown senders: chat-only, no system actions.
- Forward critical or blocked requests to admin users via sam_send.sh.
- Never reveal other users' private profiles or restrictions.`;

// ---------------------------------------------------------------------------
// ACL helpers
// ---------------------------------------------------------------------------

/**
 * Check if a sender_id (or canonical name) belongs to the 'admin' group.
 * Checks both direct sender_id match and canonical name lookup.
 */
export function isAdminMember(db: Database.Database, identifier: string): boolean {
  // Check direct sender_id membership
  const directMatch = db.prepare(
    `SELECT 1 FROM group_members WHERE group_id = 'admin' AND sender_id = ?`
  ).get(identifier);
  if (directMatch) return true;

  // Check by canonical name (lowercase first name from users.names)
  const byName = db.prepare(
    `SELECT 1 FROM group_members gm
     JOIN users u ON gm.sender_id = u.sender_id
     WHERE gm.group_id = 'admin'
       AND LOWER(JSON_EXTRACT(u.names, '$[0]')) = ?`
  ).get(identifier.toLowerCase());
  return !!byName;
}

/**
 * Get the user profile for a given sender_id.
 * Returns null if not found.
 */
export function getUserProfile(senderId: string): ParsedUser | null {
  if (!cachedRegistry) return null;
  return cachedRegistry.users.find(u => u.sender_id === senderId) ?? null;
}

/**
 * Resolve workspace path for USERS.md.
 * Tries api.config.workspaceDir first, falls back to OPENCLAW_HOME/workspace.
 */
export function resolveUsersFilePath(api: any): string {
  const workspaceDir =
    api?.config?.workspaceDir
    ?? api?.config?.workspace?.dir
    ?? path.join(process.env.OPENCLAW_HOME || path.join(require("os").homedir(), ".openclaw"), "workspace");
  return path.join(workspaceDir, "USERS.md");
}
