# Invalid index after a failed migration

Saleor's zero-downtime migration guidance builds index migrations with Django's `AddIndexConcurrently` under `atomic = False`, which compiles to Postgres `CREATE INDEX CONCURRENTLY` so large tables like `product_product` or `order_order` are not locked during the build. That build runs in multiple non-transactional passes, and if it is interrupted (deploy timeout, killed pod, lock wait timeout, dropped connection, or a uniqueness violation on a later pass), Postgres cannot roll it back atomically. It leaves a partially built index catalogued with `pg_index.indisvalid = false`, which also blocks the next deploy's migration from creating the same index name again.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/invalid-index-after-failed-migration/

## Run it

```bash
pip install psycopg[binary]      # python
npm install pg                   # node

export DATABASE_URL="postgres://user:pass@host:5432/saleor"
export MIGRATIONS_ROOT="."       # path to the Saleor checkout with the migrations/ folders
export DRY_RUN="true"

python invalid-index-after-failed-migration/python/repair_invalid_index.py
node   invalid-index-after-failed-migration/node/repair-invalid-index.js
```

`plan_invalid_index_repair` (Python) and `planInvalidIndexRepair` (Node) are pure functions: they take the rows returned by a direct query against `pg_index`, `pg_class`, and `pg_namespace`, filter to `indisvalid = false`, deduplicate by `(schema_name, index_name)`, and return one action record per invalid index. `dry_run` / `dryRun` `true` never emits anything other than `"log_only"`. The only write is `DROP INDEX CONCURRENTLY IF EXISTS`, run on an autocommit connection, followed by replaying the Django migration that originally created the index so it gets rebuilt the same way it was meant to be built. Start with `DRY_RUN=true` to review the plan first.

## Test

```bash
pytest invalid-index-after-failed-migration/python
node --test invalid-index-after-failed-migration/node
```
