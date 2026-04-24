#!/usr/bin/env npx tsx
/**
 * enroll.ts — CLI tool for user and group enrollment
 *
 * Reads a structured JSON file and populates the users, user_groups,
 * and group_members tables in the wiki-engine database.
 *
 * Usage:
 *   npx tsx scripts/enroll.ts <users.json> [--db <path>]
 *   npx tsx scripts/enroll.ts --dump [--db <path>]
 *
 * The operation is idempotent (uses INSERT OR REPLACE), so you can
 * safely re-run it after editing the file.
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UserDef {
  sender_id: string;
  names: string[]; // First = canonical (owner_id, wiki slug). Rest = aliases.
}

interface GroupDef {
  id: string;
  name: string;
  description?: string;
  scope?: string[];
  members: string[]; // Array of sender_id references
}

interface EnrollmentFile {
  users: UserDef[];
  groups: GroupDef[];
}

// ---------------------------------------------------------------------------
// Resolve DB path
// ---------------------------------------------------------------------------

function resolveDbPath(explicit?: string): string {
  if (explicit) return explicit;
  const home = process.env.OPENCLAW_HOME
    || path.join(os.homedir(), ".openclaw");
  return path.join(home, "wiki-engine", "engine.db");
}

// ---------------------------------------------------------------------------
// Validate enrollment file
// ---------------------------------------------------------------------------

function validate(data: unknown): EnrollmentFile {
  if (!data || typeof data !== "object") {
    throw new Error("File must be a JSON object with 'users' and 'groups' arrays");
  }

  const obj = data as Record<string, unknown>;

  // Validate users
  if (!Array.isArray(obj.users)) {
    throw new Error("Missing 'users' array in enrollment file");
  }

  const knownSenderIds = new Set<string>();
  for (const user of obj.users) {
    if (!user.sender_id || typeof user.sender_id !== "string") {
      throw new Error(`User missing 'sender_id': ${JSON.stringify(user)}`);
    }
    if (!Array.isArray(user.names) || user.names.length === 0) {
      throw new Error(`User '${user.sender_id}' must have 'names' array with at least one entry`);
    }
    for (const name of user.names) {
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new Error(`User '${user.sender_id}' has invalid name: ${JSON.stringify(name)}`);
      }
    }
    if (knownSenderIds.has(user.sender_id)) {
      throw new Error(`Duplicate sender_id: '${user.sender_id}'`);
    }
    knownSenderIds.add(user.sender_id);
  }

  // Validate groups
  if (!Array.isArray(obj.groups)) {
    throw new Error("Missing 'groups' array in enrollment file");
  }

  for (const group of obj.groups) {
    if (!group.id || typeof group.id !== "string") {
      throw new Error(`Group missing 'id': ${JSON.stringify(group)}`);
    }
    if (!group.name || typeof group.name !== "string") {
      throw new Error(`Group '${group.id}' missing 'name'`);
    }
    if (!Array.isArray(group.members)) {
      throw new Error(`Group '${group.id}' missing 'members' array`);
    }
    for (const memberId of group.members) {
      if (typeof memberId !== "string") {
        throw new Error(`Group '${group.id}' has invalid member: ${JSON.stringify(memberId)}`);
      }
      if (!knownSenderIds.has(memberId)) {
        throw new Error(
          `Group '${group.id}' references unknown sender_id '${memberId}'. ` +
          `Define it in the 'users' array first.`
        );
      }
    }
  }

  return obj as unknown as EnrollmentFile;
}

// ---------------------------------------------------------------------------
// Enroll
// ---------------------------------------------------------------------------

function enroll(db: Database.Database, data: EnrollmentFile): void {
  const upsertUser = db.prepare(`
    INSERT OR REPLACE INTO users (sender_id, names)
    VALUES (@sender_id, @names)
  `);

  const upsertGroup = db.prepare(`
    INSERT OR REPLACE INTO user_groups (id, name, description, scope)
    VALUES (@id, @name, @description, @scope)
  `);

  const upsertMember = db.prepare(`
    INSERT OR REPLACE INTO group_members (group_id, sender_id)
    VALUES (@group_id, @sender_id)
  `);

  // Clean sync: remove users not in file
  const deleteStaleUsers = db.prepare(`
    DELETE FROM users
    WHERE sender_id NOT IN (SELECT value FROM json_each(@keep_ids))
  `);

  // Clean sync: remove members not in file for a group
  const deleteStaleMembers = db.prepare(`
    DELETE FROM group_members
    WHERE group_id = @group_id AND sender_id NOT IN (
      SELECT value FROM json_each(@keep_ids)
    )
  `);

  const tx = db.transaction(() => {
    let userCount = 0;
    let groupCount = 0;
    let memberCount = 0;
    let removedUsers = 0;
    let removedMembers = 0;

    // --- Users ---
    for (const user of data.users) {
      upsertUser.run({
        sender_id: user.sender_id,
        names: JSON.stringify(user.names),
      });
      userCount++;
    }

    // Remove stale users
    const keepUserIds = JSON.stringify(data.users.map((u) => u.sender_id));
    const staleResult = deleteStaleUsers.run({ keep_ids: keepUserIds });
    removedUsers = staleResult.changes;

    // --- Groups ---
    for (const group of data.groups) {
      upsertGroup.run({
        id: group.id,
        name: group.name,
        description: group.description ?? null,
        scope: group.scope ? JSON.stringify(group.scope) : null,
      });
      groupCount++;

      const keepMemberIds = JSON.stringify(group.members);

      for (const memberId of group.members) {
        upsertMember.run({
          group_id: group.id,
          sender_id: memberId,
        });
        memberCount++;
      }

      // Remove stale members for this group
      const memberResult = deleteStaleMembers.run({
        group_id: group.id,
        keep_ids: keepMemberIds,
      });
      removedMembers += memberResult.changes;
    }

    return { userCount, groupCount, memberCount, removedUsers, removedMembers };
  });

  const result = tx();

  const parts = [
    `✅ Enrolled ${result.userCount} user(s), ${result.groupCount} group(s), ${result.memberCount} membership(s)`,
  ];
  if (result.removedUsers > 0) parts.push(`removed ${result.removedUsers} stale user(s)`);
  if (result.removedMembers > 0) parts.push(`removed ${result.removedMembers} stale membership(s)`);
  console.log(parts.join(", "));
}

// ---------------------------------------------------------------------------
// Dump current state
// ---------------------------------------------------------------------------

function dump(db: Database.Database): void {
  const users = db
    .prepare("SELECT sender_id, names FROM users ORDER BY sender_id")
    .all() as Array<{ sender_id: string; names: string }>;

  const groups = db
    .prepare("SELECT id, name, description, scope FROM user_groups ORDER BY id")
    .all() as Array<{ id: string; name: string; description: string | null; scope: string | null }>;

  if (users.length === 0 && groups.length === 0) {
    console.log("No users or groups found. Run enroll with a JSON file first.");
    return;
  }

  const getMembers = db.prepare(
    "SELECT sender_id FROM group_members WHERE group_id = ? ORDER BY sender_id"
  );

  const output: EnrollmentFile = {
    users: users.map((u) => ({
      sender_id: u.sender_id,
      names: JSON.parse(u.names),
    })),
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description ?? undefined,
      scope: g.scope ? JSON.parse(g.scope) : undefined,
      members: (getMembers.all(g.id) as Array<{ sender_id: string }>).map((m) => m.sender_id),
    })),
  };

  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage:
  npx tsx scripts/enroll.ts <users.json>          Import users and groups
  npx tsx scripts/enroll.ts --dump                 Export current DB state
  npx tsx scripts/enroll.ts <users.json> --db <p>  Use explicit DB path

Options:
  --db <path>   Path to engine.db (default: ~/.openclaw/wiki-engine/engine.db)
  --dump        Print current users/groups as JSON (redirect to file to edit)
  --help        Show this help

The enrollment file format:

  {
    "users": [
      { "sender_id": "7776007798", "names": ["Frodo", "Francesco"] },
      { "sender_id": "6994940390", "names": ["Galadriel", "Xhenete", "Jenny"] },
      { "sender_id": "tesssoro-daniel", "names": ["Gollum", "Daniel"] }
    ],
    "groups": [
      {
        "id": "family",
        "name": "Family",
        "description": "Core family members",
        "scope": [
          "Spesa e lista della spesa",
          "Regole della casa"
        ],
        "members": ["7776007798", "6994940390", "tesssoro-daniel"]
      }
    ]
  }

Users:
  - sender_id: raw ID from OpenClaw (Telegram numeric ID, Discord ID, etc.)
  - names: array of names. First = canonical (used as owner_id and wiki slug).
           Rest = aliases for cross-user attribution in the classifier.

Groups:
  - members: array of sender_id references (must be defined in users first)
  - scope: what types of facts belong to this group (vs individual profiles)

The operation is idempotent. Users/members present in the DB but missing
from the file are removed.
    `.trim());
    process.exit(0);
  }

  // Parse args
  const isDump = args.includes("--dump");
  const dbIdx = args.indexOf("--db");
  const explicitDb = dbIdx >= 0 ? args[dbIdx + 1] : undefined;
  const filePath = args.find(
    (a) => !a.startsWith("--") && a !== explicitDb
  );

  const dbPath = resolveDbPath(explicitDb);

  if (!fs.existsSync(dbPath)) {
    console.error(`❌ Database not found: ${dbPath}`);
    console.error("   Start the gateway once to initialize the database.");
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  try {
    if (isDump) {
      dump(db);
    } else if (filePath) {
      if (!fs.existsSync(filePath)) {
        console.error(`❌ File not found: ${filePath}`);
        process.exit(1);
      }
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = validate(JSON.parse(raw));
      enroll(db, data);
    } else {
      console.error("❌ Provide a JSON file path or --dump");
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

main();
