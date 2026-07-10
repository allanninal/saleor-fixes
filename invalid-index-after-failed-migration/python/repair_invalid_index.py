"""Find Postgres indexes left invalid by an interrupted Saleor migration
and plan a safe drop and rebuild.

Saleor's zero-downtime migration guidance builds index migrations with
Django's AddIndexConcurrently under atomic = False, which compiles to
Postgres CREATE INDEX CONCURRENTLY. That build runs in multiple
non-transactional passes, and if it is interrupted (deploy timeout, killed
pod, lock wait timeout, dropped connection, or a uniqueness violation on a
later pass), Postgres cannot roll it back atomically. It leaves a
partially built index catalogued with pg_index.indisvalid = false, which
also blocks the next deploy's migration from creating the same index name
again.

Under DRY_RUN=true (the default) this only logs the SQL it would run and
the migration it would replay. When DRY_RUN=false it drops the invalid
index with DROP INDEX CONCURRENTLY on an autocommit connection and re-runs
the originating migration. Run after any deploy that touched an index
migration. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/invalid-index-after-failed-migration/
"""
import os
import logging
import subprocess

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_invalid_index")

DATABASE_URL = os.environ.get("DATABASE_URL", "postgres://user:pass@localhost:5432/saleor")
MIGRATIONS_ROOT = os.environ.get("MIGRATIONS_ROOT", ".")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

INVALID_INDEX_QUERY = """
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
"""


def plan_invalid_index_repair(rows, dry_run):
    """Pure decision logic. No I/O.

    rows: the result set from the pg_index query above, each a dict with
    schema_name, index_name, table_name, indisvalid, indisready.

    Filters to indisvalid is False, deduplicates by (schema_name,
    index_name), and returns one action record per distinct invalid
    index. dry_run=True never emits an action other than "log_only".
    The build finished (indisready True) or never finished (indisready
    False) cases get the identical repair action; indisready is carried
    through only for audit logging.
    """
    seen = set()
    plan = []
    for row in rows:
        if row.get("indisvalid") is not False:
            continue
        key = (row["schema_name"], row["index_name"])
        if key in seen:
            continue
        seen.add(key)
        schema_name, index_name, table_name = row["schema_name"], row["index_name"], row["table_name"]
        plan.append({
            "index_name": index_name,
            "table_name": table_name,
            "action": "log_only" if dry_run else "drop_concurrently",
            "sql": f'DROP INDEX CONCURRENTLY IF EXISTS "{schema_name}"."{index_name}";',
            "requires_migration_replay": True,
            "indisready": row.get("indisready"),
        })
    return plan


def fetch_invalid_indexes(conn):
    with conn.cursor() as cur:
        cur.execute(INVALID_INDEX_QUERY)
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def find_owning_migration(index_name, migrations_root):
    import re
    import pathlib

    index_name_re = re.compile(r"""name=["']([\w-]+)["']""")
    for path in pathlib.Path(migrations_root).rglob("migrations/*.py"):
        text = path.read_text(errors="ignore")
        if "AddIndexConcurrently" not in text and "index=Index(" not in text:
            continue
        if index_name in index_name_re.findall(text):
            return {"app_label": path.parents[1].name, "migration_name": path.stem}
    return None


def drop_invalid_index(conn, sql):
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(sql)


def replay_migration(app_label, migration_name):
    subprocess.run(["python", "manage.py", "migrate", app_label, migration_name], check=True)


def run():
    import psycopg

    conn = psycopg.connect(DATABASE_URL)
    try:
        rows = fetch_invalid_indexes(conn)
        plan = plan_invalid_index_repair(rows, DRY_RUN)

        for item in plan:
            owner = find_owning_migration(item["index_name"], MIGRATIONS_ROOT)
            owner_desc = f'{owner["app_label"]}.{owner["migration_name"]}' if owner else "unknown migration"

            if item["action"] == "log_only":
                log.info("[DRY RUN] %s -- would rebuild via migration %s", item["sql"], owner_desc)
                continue

            log.warning("Dropping invalid index %s on %s", item["index_name"], item["table_name"])
            drop_invalid_index(conn, item["sql"])
            if owner:
                log.info("Replaying migration %s to rebuild %s", owner_desc, item["index_name"])
                replay_migration(owner["app_label"], owner["migration_name"])
            else:
                log.error("No owning migration found for %s, rebuild it manually", item["index_name"])

        log.info(
            "Done. %d invalid index(es) %s.",
            len(plan), "found (dry run)" if DRY_RUN else "repaired",
        )
    finally:
        conn.close()


if __name__ == "__main__":
    run()
