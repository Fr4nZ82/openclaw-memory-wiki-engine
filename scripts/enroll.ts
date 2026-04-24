#!/usr/bin/env npx tsx
/**
 * enroll.ts — CLI tool for user and group enrollment
 *
 * Reads a structured JSON file and populates the user_groups and
 * group_members tables in the wiki-engine database.
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

interface GroupDef {
  id: string;
  name: string;
  description?: string;
  scope?: string[];  // What types of facts belong to this group (vs individual profiles)
  members: MemberDef[];
}

interface MemberDef {
  sender_id: string;
  role?: string; // default: "member"
}

interface EnrollmentFile {
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
    throw new Error("File must be a JSON object with a 'groups' array");
  }

  const obj = data as Record<string, unknown>;
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
    for (const member of group.members) {
      if (!member.sender_id || typeof member.sender_id !== "string") {
        throw new Error(
          `Member in group '${group.id}' missing 'sender_id': ${JSON.stringify(member)}`
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
  const upsertGroup = db.prepare(`
    INSERT OR REPLACE INTO user_groups (id, name, description, scope)
    VALUES (@id, @name, @description, @scope)
  `);

  const upsertMember = db.prepare(`
    INSERT OR REPLACE INTO group_members (group_id, sender_id, role)
    VALUES (@group_id, @sender_id, @role)
  `);

  // Remove members not in file anymore (clean sync)
  const deleteStaleMembers = db.prepare(`
    DELETE FROM group_members
    WHERE group_id = @group_id AND sender_id NOT IN (
      SELECT value FROM json_each(@keep_ids)
    )
  `);

  const tx = db.transaction(() => {
    let groupCount = 0;
    let memberCount = 0;
    let removedCount = 0;

    for (const group of data.groups) {
      upsertGroup.run({
        id: group.id,
        name: group.name,
        description: group.description ?? null,
        scope: group.scope ? JSON.stringify(group.scope) : null,
      });
      groupCount++;

      const keepIds = JSON.stringify(group.members.map((m) => m.sender_id));

      for (const member of group.members) {
        upsertMember.run({
          group_id: group.id,
          sender_id: member.sender_id,
          role: member.role ?? "member",
        });
        memberCount++;
      }

      // Remove members that were in DB but not in file
      const result = deleteStaleMembers.run({
        group_id: group.id,
        keep_ids: keepIds,
      });
      removedCount += result.changes;
    }

    return { groupCount, memberCount, removedCount };
  });

  const result = tx();
  console.log(
    `✅ Enrolled ${result.groupCount} group(s), ${result.memberCount} member(s)` +
    (result.removedCount > 0
      ? `, removed ${result.removedCount} stale member(s)`
      : "")
  );
}

// ---------------------------------------------------------------------------
// Dump current state
// ---------------------------------------------------------------------------

function dump(db: Database.Database): void {
  const groups = db
    .prepare("SELECT id, name, description, scope FROM user_groups ORDER BY id")
    .all() as Array<{ id: string; name: string; description: string | null; scope: string | null }>;

  if (groups.length === 0) {
    console.log("No groups found. Run enroll with a JSON file first.");
    return;
  }

  const getMembers = db.prepare(
    "SELECT sender_id, role FROM group_members WHERE group_id = ? ORDER BY role DESC, sender_id"
  );

  const output: EnrollmentFile = {
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description ?? undefined,
      scope: g.scope ? JSON.parse(g.scope) : undefined,
      members: (getMembers.all(g.id) as MemberDef[]),
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
  npx tsx scripts/enroll.ts <users.json>          Import groups and members
  npx tsx scripts/enroll.ts --dump                 Export current DB state
  npx tsx scripts/enroll.ts <users.json> --db <p>  Use explicit DB path

Options:
  --db <path>   Path to engine.db (default: ~/.openclaw/wiki-engine/engine.db)
  --dump        Print current groups/members as JSON (redirect to file to edit)
  --help        Show this help

The enrollment file format:

  {
    "groups": [
      {
        "id": "family",
        "name": "Family",
        "description": "Core family members",
        "scope": [
          "Spesa e lista della spesa",
          "Regole della casa",
          "Piani condivisi (vacanze, uscite)"
        ],
        "members": [
          { "sender_id": "alice", "role": "admin" },
          { "sender_id": "bob" },
          { "sender_id": "charlie" }
        ]
      }
    ]
  }

Roles: "admin" or "member" (default). The operation is idempotent.
Members present in the DB but missing from the file are removed.
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
