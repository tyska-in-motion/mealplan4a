import type { Pool } from "pg";

/**
 * Apply the produce-tracking schema at startup.
 *
 * Render deployments do not automatically execute SQL files in migrations/,
 * so this idempotent compatibility step keeps existing databases in sync
 * before routes start querying the new columns.
 */
export async function ensureProduceTrackingSchema(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE ingredients
    ADD COLUMN IF NOT EXISTS produce_type text,
    ADD COLUMN IF NOT EXISTS produce_percentage real NOT NULL DEFAULT 100`);

  // Keep the runtime constraint in sync with migration 0034. Existing databases
  // may still have the earlier constraint that rejects the explicit "none" value.
  await pool.query(`ALTER TABLE ingredients
    DROP CONSTRAINT IF EXISTS ingredients_produce_type_check`);
  await pool.query(`ALTER TABLE ingredients
    ADD CONSTRAINT ingredients_produce_type_check
    CHECK (produce_type IS NULL OR produce_type IN ('vegetable', 'fruit', 'none'))`);

  await pool.query(`ALTER TABLE user_settings
    ADD COLUMN IF NOT EXISTS target_vegetables real NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS target_fruits real NOT NULL DEFAULT 0`);

  await pool.query(`ALTER TABLE user_settings_history
    ADD COLUMN IF NOT EXISTS target_vegetables real NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS target_fruits real NOT NULL DEFAULT 0`);

  await pool.query(`DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'ingredients_produce_type_check'
        AND conrelid = 'ingredients'::regclass
    ) THEN
      ALTER TABLE ingredients
        ADD CONSTRAINT ingredients_produce_type_check
        CHECK (produce_type IS NULL OR produce_type IN ('vegetable', 'fruit'));
    END IF;
  END $$`);
}
