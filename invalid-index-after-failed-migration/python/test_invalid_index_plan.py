from repair_invalid_index import plan_invalid_index_repair


def row(**over):
    base = {
        "schema_name": "public",
        "index_name": "product_product_name_idx",
        "table_name": "product_product",
        "indisvalid": False,
        "indisready": True,
    }
    base.update(over)
    return base


def test_empty_input_returns_empty_plan():
    assert plan_invalid_index_repair([], dry_run=True) == []


def test_valid_index_is_excluded():
    plan = plan_invalid_index_repair([row(indisvalid=True)], dry_run=True)
    assert plan == []


def test_invalid_and_not_ready_still_plans_drop_concurrently():
    plan = plan_invalid_index_repair([row(indisready=False)], dry_run=False)
    assert plan[0]["action"] == "drop_concurrently"
    assert plan[0]["indisready"] is False


def test_invalid_and_ready_still_plans_drop_concurrently():
    plan = plan_invalid_index_repair([row(indisready=True)], dry_run=False)
    assert plan[0]["action"] == "drop_concurrently"
    assert plan[0]["indisready"] is True


def test_dry_run_true_never_emits_anything_but_log_only():
    plan = plan_invalid_index_repair([row(indisready=False), row(indisready=True)], dry_run=True)
    assert all(item["action"] == "log_only" for item in plan)


def test_deduplicates_by_schema_and_index_name():
    rows = [row(), row()]
    plan = plan_invalid_index_repair(rows, dry_run=True)
    assert len(plan) == 1


def test_different_index_names_are_not_deduplicated():
    rows = [row(index_name="a_idx"), row(index_name="b_idx")]
    plan = plan_invalid_index_repair(rows, dry_run=True)
    assert len(plan) == 2


def test_sql_uses_drop_index_concurrently_if_exists():
    plan = plan_invalid_index_repair([row()], dry_run=True)
    assert plan[0]["sql"] == 'DROP INDEX CONCURRENTLY IF EXISTS "public"."product_product_name_idx";'


def test_requires_migration_replay_is_always_true():
    plan = plan_invalid_index_repair([row()], dry_run=True)
    assert plan[0]["requires_migration_replay"] is True


def test_table_name_is_carried_through():
    plan = plan_invalid_index_repair([row(table_name="order_order")], dry_run=True)
    assert plan[0]["table_name"] == "order_order"
