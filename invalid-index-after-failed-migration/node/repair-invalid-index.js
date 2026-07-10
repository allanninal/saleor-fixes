/**
 * Find Postgres indexes left invalid by an interrupted Saleor migration
 * and plan a safe drop and rebuild.
 *
 * Saleor's zero-downtime migration guidance builds index migrations with
 * Django's AddIndexConcurrently under atomic = False, which compiles to
 * Postgres CREATE INDEX CONCURRENTLY. That build runs in multiple
 * non-transactional passes, and if it is interrupted (deploy timeout,
 * killed pod, lock wait timeout, dropped connection, or a uniqueness
 * violation on a later pass), Postgres cannot roll it back atomically. It
 * leaves a partially built index catalogued with indisvalid = false,
 * which also blocks the next deploy's migration from creating the same
 * index name again.
 *
 * Under DRY_RUN=true (the default) this only logs the SQL it would run
 * and the migration it would replay. When DRY_RUN=false it drops the
 * invalid index with DROP INDEX CONCURRENTLY and re-runs the originating
 * migration. Run after any deploy that touched an index migration.
 *
 * Guide: https://www.allanninal.dev/saleor/invalid-index-after-failed-migration/
 */
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/saleor";
const MIGRATIONS_ROOT = process.env.MIGRATIONS_ROOT || ".";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const INVALID_INDEX_QUERY = `
SELECT n.nspname AS schema_name,
       c.relname AS index_name,
       t.relname AS table_name,
       i.indisvalid,
       i.indisready
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE i.indisvalid = false;
`;

/**
 * Pure decision logic. No I/O.
 *
 * rows: the result set from the pg_index query above, each an object
 * with schema_name, index_name, table_name, indisvalid, indisready.
 *
 * Filters to indisvalid === false, deduplicates by (schema_name,
 * index_name), and returns one action record per distinct invalid
 * index. dryRun === true never emits an action other than "log_only".
 * The build finished (indisready true) or never finished (indisready
 * false) cases get the identical repair action; indisready is carried
 * through only for audit logging.
 */
export function planInvalidIndexRepair(rows, dryRun) {
  const seen = new Set();
  const plan = [];
  for (const row of rows) {
    if (row.indisvalid !== false) continue;
    const key = `${row.schema_name}.${row.index_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { schema_name: schemaName, index_name: indexName, table_name: tableName } = row;
    plan.push({
      index_name: indexName,
      table_name: tableName,
      action: dryRun ? "log_only" : "drop_concurrently",
      sql: `DROP INDEX CONCURRENTLY IF EXISTS "${schemaName}"."${indexName}";`,
      requires_migration_replay: true,
      indisready: row.indisready,
    });
  }
  return plan;
}

async function fetchInvalidIndexes(client) {
  const { rows } = await client.query(INVALID_INDEX_QUERY);
  return rows;
}

const INDEX_NAME_RE = /name=["']([\w-]+)["']/g;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function findOwningMigration(indexName, migrationsRoot) {
  const files = walk(migrationsRoot).filter(
    (p) => p.includes(`${path.sep}migrations${path.sep}`) && p.endsWith(".py")
  );
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("AddIndexConcurrently") && !text.includes("index=Index(")) continue;
    const names = [...text.matchAll(INDEX_NAME_RE)].map((m) => m[1]);
    if (names.includes(indexName)) {
      const parts = file.split(path.sep);
      const appLabel = parts[parts.length - 3];
      const migrationName = path.basename(file, ".py");
      return { appLabel, migrationName };
    }
  }
  return null;
}

async function dropInvalidIndex(client, sql) {
  await client.query(sql);
}

async function replayMigration(appLabel, migrationName) {
  await execFileAsync("python", ["manage.py", "migrate", appLabel, migrationName]);
}

export async function run() {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const rows = await fetchInvalidIndexes(client);
    const plan = planInvalidIndexRepair(rows, DRY_RUN);

    for (const item of plan) {
      const owner = findOwningMigration(item.index_name, MIGRATIONS_ROOT);
      const ownerDesc = owner ? `${owner.appLabel}.${owner.migrationName}` : "unknown migration";

      if (item.action === "log_only") {
        console.log(`[DRY RUN] ${item.sql} -- would rebuild via migration ${ownerDesc}`);
        continue;
      }

      console.warn(`Dropping invalid index ${item.index_name} on ${item.table_name}`);
      await dropInvalidIndex(client, item.sql);
      if (owner) {
        console.log(`Replaying migration ${ownerDesc} to rebuild ${item.index_name}`);
        await replayMigration(owner.appLabel, owner.migrationName);
      } else {
        console.error(`No owning migration found for ${item.index_name}, rebuild it manually`);
      }
    }

    console.log(`Done. ${plan.length} invalid index(es) ${DRY_RUN ? "found (dry run)" : "repaired"}.`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
