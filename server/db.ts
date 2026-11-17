import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

function isSupabasePooler(connectionString: string) {
  try {
    return new URL(connectionString).hostname.endsWith(".pooler.supabase.com");
  } catch {
    return false;
  }
}

function buildPoolConfig(connectionString: string): PoolConfig {
  const sslMode = process.env.PGSSLMODE?.toLowerCase();
  const sslDisabled = sslMode === "disable";

  return {
    connectionString,
    // Render connects to Supabase from outside Supabase's network. The pooler
    // requires SSL, but Render does not provide Supabase's CA bundle by default.
    // Keep certificate validation disabled unless explicitly opted out via
    // PGSSLMODE=disable for local-only setups.
    ssl: sslDisabled ? undefined : { rejectUnauthorized: false },
    // Supabase's transaction pooler is happiest with a tiny application pool;
    // this also avoids burning through connection limits on small projects.
    max: isSupabasePooler(connectionString) ? 1 : undefined,
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000),
  };
}

export const pool = new Pool(buildPoolConfig(process.env.DATABASE_URL));

export const db = drizzle(pool, { schema });


async function ensureBaseTables() {
  await pool.query(`DO $$ BEGIN
    CREATE TYPE ingredient_scaling_type AS ENUM ('LINEAR', 'FIXED', 'STEP', 'FORMULA');
  EXCEPTION
    WHEN duplicate_object THEN null;
  END $$;`);

  await pool.query(`CREATE TABLE IF NOT EXISTS ingredients (
    id serial PRIMARY KEY,
    name text NOT NULL,
    category text,
    calories integer NOT NULL,
    protein real NOT NULL,
    carbs real NOT NULL,
    fat real NOT NULL,
    sugar real NOT NULL DEFAULT 0,
    fiber real NOT NULL DEFAULT 0,
    unit text NOT NULL DEFAULT 'g',
    unit_weight real,
    unit_description text,
    price real DEFAULT 0,
    package_size real NOT NULL DEFAULT 100,
    package_price real NOT NULL DEFAULT 0,
    pricing_updated_at timestamp NOT NULL DEFAULT now(),
    image_url text,
    always_at_home boolean NOT NULL DEFAULT false,
    edible_percentage real NOT NULL DEFAULT 100,
    increase_purchase_for_waste boolean NOT NULL DEFAULT false,
    use_soon boolean NOT NULL DEFAULT false
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS recipes (
    id serial PRIMARY KEY,
    name text NOT NULL,
    is_favorite boolean NOT NULL DEFAULT false,
    suggested_recipe_ids integer[] NOT NULL DEFAULT '{}'::integer[],
    suggested_recipes jsonb NOT NULL DEFAULT '[]'::jsonb,
    tags text[],
    description text,
    instructions text,
    comments text,
    instruction_steps jsonb,
    prep_time integer,
    image_url text,
    servings real NOT NULL DEFAULT 1,
    default_servings_a real NOT NULL DEFAULT 1,
    default_servings_b real NOT NULL DEFAULT 1.5,
    created_at timestamp DEFAULT now()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS recipe_ingredients (
    id serial PRIMARY KEY,
    recipe_id integer NOT NULL,
    ingredient_id integer NOT NULL,
    group_name text,
    amount integer NOT NULL,
    base_amount real NOT NULL,
    alternative_amount real,
    alternative_unit text,
    unit text NOT NULL DEFAULT 'g',
    scaling_type ingredient_scaling_type NOT NULL DEFAULT 'LINEAR',
    scaling_formula text,
    step_thresholds jsonb,
    meal_prep boolean NOT NULL DEFAULT false,
    meal_prep_max_days_before integer NOT NULL DEFAULT 1,
    meal_prep_notes text
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS recipe_frequent_addons (
    id serial PRIMARY KEY,
    recipe_id integer NOT NULL,
    ingredient_id integer NOT NULL,
    amount integer NOT NULL,
    base_amount real NOT NULL,
    default_amount_a real NOT NULL DEFAULT 0,
    default_amount_b real NOT NULL DEFAULT 0,
    alternative_amount real,
    alternative_unit text,
    unit text NOT NULL DEFAULT 'g',
    scaling_type ingredient_scaling_type NOT NULL DEFAULT 'LINEAR',
    scaling_formula text,
    step_thresholds jsonb
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS meal_entries (
    id serial PRIMARY KEY,
    date text NOT NULL,
    recipe_id integer,
    custom_name text,
    custom_calories integer,
    custom_protein real,
    custom_carbs real,
    custom_fat real,
    custom_sugar real NOT NULL DEFAULT 0,
    custom_fiber real NOT NULL DEFAULT 0,
    meal_type text NOT NULL,
    person text NOT NULL DEFAULT 'A',
    servings real NOT NULL DEFAULT 1,
    cooked_batch_id integer,
    recipe_snapshot jsonb,
    is_eaten boolean DEFAULT false,
    created_at timestamp DEFAULT now()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS meal_entry_ingredients (
    id serial PRIMARY KEY,
    meal_entry_id integer NOT NULL,
    ingredient_id integer NOT NULL,
    amount integer NOT NULL,
    scaling_type ingredient_scaling_type NOT NULL DEFAULT 'LINEAR'
  )`);
}

export async function ensureDbCompat() {
  await ensureBaseTables();

  // Keep runtime bootstrap aligned with schema/migrations. Some deployments do
  // not execute SQL migration files automatically, so CREATE/ALTER must be safe
  // both for fresh databases and for existing installations.
  await pool.query(`CREATE TABLE IF NOT EXISTS app_state (
    key text PRIMARY KEY,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamp DEFAULT now()
  )`);

  // A/B/C recipe portioning compatibility (migration 0031).
  await pool.query(`ALTER TABLE recipes
    ADD COLUMN IF NOT EXISTS portioning_mode text NOT NULL DEFAULT 'shared',
    ADD COLUMN IF NOT EXISTS default_variant_a text NOT NULL DEFAULT 'B',
    ADD COLUMN IF NOT EXISTS default_variant_b text NOT NULL DEFAULT 'B'`);
  await pool.query(`ALTER TABLE recipe_ingredients
    ADD COLUMN IF NOT EXISTS variant_amount_a real,
    ADD COLUMN IF NOT EXISTS variant_amount_b real,
    ADD COLUMN IF NOT EXISTS variant_amount_c real`);
  await pool.query(`ALTER TABLE meal_entries
    ADD COLUMN IF NOT EXISTS portion_variant text,
    ADD COLUMN IF NOT EXISTS ingredients_modified boolean NOT NULL DEFAULT false`);
  // Individual variants can contain fractional ingredient quantities.
  await pool.query(`ALTER TABLE meal_entry_ingredients ALTER COLUMN amount TYPE real USING amount::real`);
  // Backward-compatible self-healing for ingredients migration
  await pool.query(`ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS sugar real DEFAULT 0`);
  await pool.query(`ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS fiber real DEFAULT 0`);
  await pool.query(`UPDATE ingredients SET sugar = 0 WHERE sugar IS NULL`);
  await pool.query(`UPDATE ingredients SET fiber = 0 WHERE fiber IS NULL`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN sugar SET NOT NULL`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN fiber SET NOT NULL`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN sugar SET DEFAULT 0`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN fiber SET DEFAULT 0`);

  await pool.query(`ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS always_at_home boolean DEFAULT false`);
  await pool.query(`UPDATE ingredients SET always_at_home = false WHERE always_at_home IS NULL`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN always_at_home SET NOT NULL`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN always_at_home SET DEFAULT false`);

  // Backward-compatible self-healing for ingredient edible/purchase-waste settings.
  // Render deployments do not run SQL files automatically, so keep runtime DB compat
  // in sync with migrations to avoid booting new code against an old database.
  await pool.query(`ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS edible_percentage real DEFAULT 100`);
  await pool.query(`UPDATE ingredients SET edible_percentage = 100 WHERE edible_percentage IS NULL OR edible_percentage <= 0`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN edible_percentage SET NOT NULL`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN edible_percentage SET DEFAULT 100`);

  await pool.query(`ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS increase_purchase_for_waste boolean DEFAULT false`);
  await pool.query(`UPDATE ingredients SET increase_purchase_for_waste = false WHERE increase_purchase_for_waste IS NULL`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN increase_purchase_for_waste SET NOT NULL`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN increase_purchase_for_waste SET DEFAULT false`);

  // Backward-compatible self-healing for ingredients that should be used quickly.
  await pool.query(`ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS use_soon boolean DEFAULT false`);
  await pool.query(`UPDATE ingredients SET use_soon = false WHERE use_soon IS NULL`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN use_soon SET NOT NULL`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN use_soon SET DEFAULT false`);

  // Backward-compatible self-healing for package-based ingredient pricing.
  // The app stores package details and keeps ingredients.price as calculated PLN/100g.
  await pool.query(`ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS package_size real DEFAULT 100`);
  await pool.query(`ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS package_price real DEFAULT 0`);
  await pool.query(`UPDATE ingredients SET package_size = 100 WHERE package_size IS NULL OR package_size <= 0`);
  await pool.query(`UPDATE ingredients SET package_price = COALESCE(price, 0) WHERE package_price IS NULL OR package_price <= 0`);
  await pool.query(`UPDATE ingredients SET price = ROUND(((package_price / NULLIF(package_size, 0)) * 100)::numeric, 4)::real WHERE package_size > 0`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN package_size SET NOT NULL`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN package_size SET DEFAULT 100`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN package_price SET NOT NULL`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN package_price SET DEFAULT 0`);

  await pool.query(`ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS pricing_updated_at timestamp DEFAULT NOW()`);
  await pool.query(`UPDATE ingredients SET pricing_updated_at = NOW() WHERE pricing_updated_at IS NULL`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN pricing_updated_at SET NOT NULL`);
  await pool.query(`ALTER TABLE ingredients ALTER COLUMN pricing_updated_at SET DEFAULT NOW()`);

  await pool.query(`ALTER TABLE meal_entries ADD COLUMN IF NOT EXISTS custom_sugar real DEFAULT 0`);
  await pool.query(`ALTER TABLE meal_entries ADD COLUMN IF NOT EXISTS custom_fiber real DEFAULT 0`);
  await pool.query(`UPDATE meal_entries SET custom_sugar = 0 WHERE custom_sugar IS NULL`);
  await pool.query(`UPDATE meal_entries SET custom_fiber = 0 WHERE custom_fiber IS NULL`);
  await pool.query(`ALTER TABLE meal_entries ALTER COLUMN custom_sugar SET NOT NULL`);
  await pool.query(`ALTER TABLE meal_entries ALTER COLUMN custom_fiber SET NOT NULL`);
  await pool.query(`ALTER TABLE meal_entries ALTER COLUMN custom_sugar SET DEFAULT 0`);
  await pool.query(`ALTER TABLE meal_entries ALTER COLUMN custom_fiber SET DEFAULT 0`);

  await pool.query(`ALTER TABLE meal_entries ADD COLUMN IF NOT EXISTS person text DEFAULT 'A'`);
  await pool.query(`UPDATE meal_entries SET person = 'A' WHERE person IS NULL`);
  await pool.query(`ALTER TABLE meal_entries ALTER COLUMN person SET NOT NULL`);

  await pool.query(`CREATE TABLE IF NOT EXISTS user_settings (
    id serial PRIMARY KEY,
    target_calories integer NOT NULL DEFAULT 2000,
    target_protein integer NOT NULL DEFAULT 150,
    target_carbs integer NOT NULL DEFAULT 200,
    target_fat integer NOT NULL DEFAULT 65,
    target_protein_percentage_min integer NOT NULL DEFAULT 30,
    target_protein_percentage_max integer NOT NULL DEFAULT 30,
    target_carbs_percentage_min integer NOT NULL DEFAULT 40,
    target_carbs_percentage_max integer NOT NULL DEFAULT 40,
    target_fat_percentage_min integer NOT NULL DEFAULT 30,
    target_fat_percentage_max integer NOT NULL DEFAULT 30
  )`);

  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_sugar_min real DEFAULT 0`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_sugar_max real DEFAULT 0`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_fiber_min real DEFAULT 0`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_fiber_max real DEFAULT 0`);
  await pool.query(`UPDATE user_settings SET target_sugar_min = 0 WHERE target_sugar_min IS NULL`);
  await pool.query(`UPDATE user_settings SET target_sugar_max = 0 WHERE target_sugar_max IS NULL`);
  await pool.query(`UPDATE user_settings SET target_fiber_min = 0 WHERE target_fiber_min IS NULL`);
  await pool.query(`UPDATE user_settings SET target_fiber_max = 0 WHERE target_fiber_max IS NULL`);

  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_calories integer DEFAULT 2000`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_protein integer DEFAULT 150`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_carbs integer DEFAULT 200`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_fat integer DEFAULT 65`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_protein_percentage integer DEFAULT 30`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_carbs_percentage integer DEFAULT 40`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_fat_percentage integer DEFAULT 30`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_protein_percentage_min integer DEFAULT 30`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_protein_percentage_max integer DEFAULT 30`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_carbs_percentage_min integer DEFAULT 40`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_carbs_percentage_max integer DEFAULT 40`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_fat_percentage_min integer DEFAULT 30`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_fat_percentage_max integer DEFAULT 30`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS shared_batches_manual_only boolean DEFAULT true`);
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS calorie_goal_mode text NOT NULL DEFAULT 'maintenance'`);
  await pool.query(`UPDATE user_settings SET target_calories = 2000 WHERE target_calories IS NULL`);
  await pool.query(`UPDATE user_settings SET target_protein = 150 WHERE target_protein IS NULL`);
  await pool.query(`UPDATE user_settings SET target_carbs = 200 WHERE target_carbs IS NULL`);
  await pool.query(`UPDATE user_settings SET target_fat = 65 WHERE target_fat IS NULL`);
  await pool.query(`UPDATE user_settings SET target_protein_percentage = CASE WHEN target_calories > 0 THEN ROUND((target_protein * 4.0 / target_calories) * 100)::integer ELSE 0 END WHERE target_protein_percentage IS NULL`);
  await pool.query(`UPDATE user_settings SET target_carbs_percentage = CASE WHEN target_calories > 0 THEN ROUND((target_carbs * 4.0 / target_calories) * 100)::integer ELSE 0 END WHERE target_carbs_percentage IS NULL`);
  await pool.query(`UPDATE user_settings SET target_fat_percentage = CASE WHEN target_calories > 0 THEN ROUND((target_fat * 9.0 / target_calories) * 100)::integer ELSE 0 END WHERE target_fat_percentage IS NULL`);
  await pool.query(`UPDATE user_settings SET target_protein_percentage_min = target_protein_percentage WHERE target_protein_percentage_min IS NULL`);
  await pool.query(`UPDATE user_settings SET target_protein_percentage_max = target_protein_percentage WHERE target_protein_percentage_max IS NULL`);
  await pool.query(`UPDATE user_settings SET target_carbs_percentage_min = target_carbs_percentage WHERE target_carbs_percentage_min IS NULL`);
  await pool.query(`UPDATE user_settings SET target_carbs_percentage_max = target_carbs_percentage WHERE target_carbs_percentage_max IS NULL`);
  await pool.query(`UPDATE user_settings SET target_fat_percentage_min = target_fat_percentage WHERE target_fat_percentage_min IS NULL`);
  await pool.query(`UPDATE user_settings SET target_fat_percentage_max = target_fat_percentage WHERE target_fat_percentage_max IS NULL`);
  await pool.query(`UPDATE user_settings SET shared_batches_manual_only = true WHERE shared_batches_manual_only IS NULL`);
  await pool.query(`ALTER TABLE user_settings ALTER COLUMN target_calories SET NOT NULL`);
  await pool.query(`ALTER TABLE user_settings ALTER COLUMN target_protein SET NOT NULL`);
  await pool.query(`ALTER TABLE user_settings ALTER COLUMN target_carbs SET NOT NULL`);
  await pool.query(`ALTER TABLE user_settings ALTER COLUMN target_fat SET NOT NULL`);
  await pool.query(`ALTER TABLE user_settings ALTER COLUMN target_protein_percentage SET NOT NULL`);
  await pool.query(`ALTER TABLE user_settings ALTER COLUMN target_carbs_percentage SET NOT NULL`);
  await pool.query(`ALTER TABLE user_settings ALTER COLUMN target_fat_percentage SET NOT NULL`);
  for (const column of ["target_protein_percentage_min", "target_protein_percentage_max", "target_carbs_percentage_min", "target_carbs_percentage_max", "target_fat_percentage_min", "target_fat_percentage_max"]) {
    await pool.query(`ALTER TABLE user_settings ALTER COLUMN ${column} SET NOT NULL`);
  }
  await pool.query(`ALTER TABLE user_settings ALTER COLUMN target_protein_percentage SET DEFAULT 30`);
  await pool.query(`ALTER TABLE user_settings ALTER COLUMN target_carbs_percentage SET DEFAULT 40`);
  await pool.query(`ALTER TABLE user_settings ALTER COLUMN target_fat_percentage SET DEFAULT 30`);
  await pool.query(`ALTER TABLE user_settings ALTER COLUMN shared_batches_manual_only SET NOT NULL`);

  // Backward compatibility for environments that already query per-person settings.
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS person text DEFAULT 'A'`);

  await pool.query(`CREATE TABLE IF NOT EXISTS user_settings_history (
    id serial PRIMARY KEY,
    person text NOT NULL,
    effective_date date NOT NULL,
    target_calories integer NOT NULL,
    target_protein integer NOT NULL,
    target_carbs integer NOT NULL,
    target_fat integer NOT NULL,
    target_protein_percentage integer NOT NULL DEFAULT 30,
    target_carbs_percentage integer NOT NULL DEFAULT 40,
    target_fat_percentage integer NOT NULL DEFAULT 30,
    target_protein_percentage_min integer NOT NULL DEFAULT 30,
    target_protein_percentage_max integer NOT NULL DEFAULT 30,
    target_carbs_percentage_min integer NOT NULL DEFAULT 40,
    target_carbs_percentage_max integer NOT NULL DEFAULT 40,
    target_fat_percentage_min integer NOT NULL DEFAULT 30,
    target_fat_percentage_max integer NOT NULL DEFAULT 30,
    created_at timestamp DEFAULT now()
  )`);
  await pool.query(`ALTER TABLE user_settings_history ADD COLUMN IF NOT EXISTS calorie_goal_mode text NOT NULL DEFAULT 'maintenance'`);
  await pool.query(`ALTER TABLE user_settings_history ADD COLUMN IF NOT EXISTS target_sugar_min real DEFAULT 0`);
  await pool.query(`ALTER TABLE user_settings_history ADD COLUMN IF NOT EXISTS target_sugar_max real DEFAULT 0`);
  await pool.query(`ALTER TABLE user_settings_history ADD COLUMN IF NOT EXISTS target_fiber_min real DEFAULT 0`);
  await pool.query(`ALTER TABLE user_settings_history ADD COLUMN IF NOT EXISTS target_fiber_max real DEFAULT 0`);
  await pool.query(`UPDATE user_settings_history SET target_sugar_min = 0 WHERE target_sugar_min IS NULL`);
  await pool.query(`UPDATE user_settings_history SET target_sugar_max = 0 WHERE target_sugar_max IS NULL`);
  await pool.query(`UPDATE user_settings_history SET target_fiber_min = 0 WHERE target_fiber_min IS NULL`);
  await pool.query(`UPDATE user_settings_history SET target_fiber_max = 0 WHERE target_fiber_max IS NULL`);

  await pool.query(`ALTER TABLE user_settings_history ADD COLUMN IF NOT EXISTS target_protein_percentage_min integer DEFAULT 30`);
  await pool.query(`ALTER TABLE user_settings_history ADD COLUMN IF NOT EXISTS target_protein_percentage_max integer DEFAULT 30`);
  await pool.query(`ALTER TABLE user_settings_history ADD COLUMN IF NOT EXISTS target_carbs_percentage_min integer DEFAULT 40`);
  await pool.query(`ALTER TABLE user_settings_history ADD COLUMN IF NOT EXISTS target_carbs_percentage_max integer DEFAULT 40`);
  await pool.query(`ALTER TABLE user_settings_history ADD COLUMN IF NOT EXISTS target_fat_percentage_min integer DEFAULT 30`);
  await pool.query(`ALTER TABLE user_settings_history ADD COLUMN IF NOT EXISTS target_fat_percentage_max integer DEFAULT 30`);
  await pool.query(`UPDATE user_settings_history SET target_protein_percentage_min = target_protein_percentage WHERE target_protein_percentage_min IS NULL`);
  await pool.query(`UPDATE user_settings_history SET target_protein_percentage_max = target_protein_percentage WHERE target_protein_percentage_max IS NULL`);
  await pool.query(`UPDATE user_settings_history SET target_carbs_percentage_min = target_carbs_percentage WHERE target_carbs_percentage_min IS NULL`);
  await pool.query(`UPDATE user_settings_history SET target_carbs_percentage_max = target_carbs_percentage WHERE target_carbs_percentage_max IS NULL`);
  await pool.query(`UPDATE user_settings_history SET target_fat_percentage_min = target_fat_percentage WHERE target_fat_percentage_min IS NULL`);
  await pool.query(`UPDATE user_settings_history SET target_fat_percentage_max = target_fat_percentage WHERE target_fat_percentage_max IS NULL`);
  for (const column of ["target_protein_percentage_min", "target_protein_percentage_max", "target_carbs_percentage_min", "target_carbs_percentage_max", "target_fat_percentage_min", "target_fat_percentage_max"]) {
    await pool.query(`ALTER TABLE user_settings_history ALTER COLUMN ${column} SET NOT NULL`);
  }
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS user_settings_history_person_effective_date_idx ON user_settings_history (person, effective_date)`);

  await pool.query(`CREATE TABLE IF NOT EXISTS shopping_list_notebook_items (
    id serial PRIMARY KEY,
    name text NOT NULL,
    created_at timestamp DEFAULT now()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS stats_day_exclusions (
    date date NOT NULL,
    person text NOT NULL DEFAULT 'A',
    reason text NOT NULL,
    updated_at timestamp DEFAULT now(),
    PRIMARY KEY (date, person)
  )`);
  // Detect the legacy date-only table before adding the person column. Only
  // that first transition should copy old shared exclusions to both people.
  const personColumnCheck = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'stats_day_exclusions'
       AND column_name = 'person'`
  );
  const hadPersonSpecificExclusions = Boolean(personColumnCheck && personColumnCheck.rowCount && personColumnCheck.rowCount > 0);

  await pool.query(`CREATE TABLE IF NOT EXISTS body_measurements (
    id serial PRIMARY KEY,
    person text NOT NULL,
    date date NOT NULL,
    weight real,
    waist real,
    chest real,
    arm real,
    thigh real,
    calf real,
    hips real,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
  )`);
  await pool.query(`ALTER TABLE body_measurements ALTER COLUMN weight DROP NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS body_measurements_person_date_idx ON body_measurements (person, date)`);

  await pool.query(`ALTER TABLE stats_day_exclusions ADD COLUMN IF NOT EXISTS reason text`);
  await pool.query(`UPDATE stats_day_exclusions SET reason = 'Brak powodu' WHERE reason IS NULL OR trim(reason) = ''`);
  await pool.query(`ALTER TABLE stats_day_exclusions ALTER COLUMN reason SET NOT NULL`);
  await pool.query(`ALTER TABLE stats_day_exclusions ADD COLUMN IF NOT EXISTS updated_at timestamp DEFAULT now()`);
  await pool.query(`ALTER TABLE stats_day_exclusions ADD COLUMN IF NOT EXISTS person text DEFAULT 'A'`);
  await pool.query(`UPDATE stats_day_exclusions SET person = 'A' WHERE person IS NULL`);
  await pool.query(`ALTER TABLE stats_day_exclusions DROP CONSTRAINT IF EXISTS stats_day_exclusions_pkey`);
  await pool.query(`ALTER TABLE stats_day_exclusions ALTER COLUMN person SET NOT NULL`);

  await pool.query(`CREATE TABLE IF NOT EXISTS runtime_compat_migrations (
    id text PRIMARY KEY,
    applied_at timestamp NOT NULL DEFAULT now()
  )`);

  if (!hadPersonSpecificExclusions) {
    // One-time conversion of legacy shared exclusions: preserve the old
    // behavior for dates that existed before per-person exclusions.
    await pool.query(`INSERT INTO stats_day_exclusions (date, person, reason, updated_at)
      SELECT date, 'B', reason, updated_at
      FROM stats_day_exclusions
      WHERE person = 'A'
      ON CONFLICT (date, person) DO NOTHING`);
    // Mark the conversion as complete so the next startup does not mistake
    // these intentional legacy copies for copies created by older buggy builds.
    await pool.query(`INSERT INTO runtime_compat_migrations (id)
      VALUES ('stats-day-exclusions-remove-startup-mirrors-v1')
      ON CONFLICT DO NOTHING`);
  } else {
    // Earlier builds repeated the legacy A -> B copy on every server startup.
    // Remove those exact mirrored rows once so restoring B remains persistent.
    // Independently changed B rows have a different updated_at and are retained.
    await pool.query(`
      WITH first_run AS (
        INSERT INTO runtime_compat_migrations (id)
        VALUES ('stats-day-exclusions-remove-startup-mirrors-v1')
        ON CONFLICT DO NOTHING
        RETURNING id
      )
      DELETE FROM stats_day_exclusions AS b
      USING stats_day_exclusions AS a
      WHERE EXISTS (SELECT 1 FROM first_run)
        AND a.date = b.date
        AND a.person = 'A'
        AND b.person = 'B'
        AND a.reason = b.reason
        AND a.updated_at IS NOT DISTINCT FROM b.updated_at
    `);
  }

  // A previous compatibility migration could mark the v1 cleanup as done
  // while preserving A -> B mirror rows created by old startup code. Run a
  // separate v2 cleanup on already-migrated databases. It deletes only exact
  // copies (same date, reason and updated_at), never independently edited B rows.
  await pool.query(`
    WITH first_run AS (
      INSERT INTO runtime_compat_migrations (id)
      VALUES ('stats-day-exclusions-remove-startup-mirrors-v2')
      ON CONFLICT DO NOTHING
      RETURNING id
    )
    DELETE FROM stats_day_exclusions AS b
    USING stats_day_exclusions AS a
    WHERE EXISTS (SELECT 1 FROM first_run)
      AND a.date = b.date
      AND a.person = 'A'
      AND b.person = 'B'
      AND a.reason = b.reason
      AND a.updated_at IS NOT DISTINCT FROM b.updated_at
  `);

  // A previous interrupted conversion can leave duplicate pairs; normalize
  // them before enforcing the date+person key.
  await pool.query(`DELETE FROM stats_day_exclusions AS duplicate
    USING stats_day_exclusions AS retained
    WHERE duplicate.date = retained.date
      AND duplicate.person = retained.person
      AND duplicate.ctid < retained.ctid`);
  await pool.query(`ALTER TABLE stats_day_exclusions ADD CONSTRAINT stats_day_exclusions_pkey PRIMARY KEY (date, person)`);

  // Backward-compatible self-healing for recipe comments field
  await pool.query(`ALTER TABLE recipes ADD COLUMN IF NOT EXISTS comments text`);
  await pool.query(`ALTER TABLE recipes ADD COLUMN IF NOT EXISTS default_servings_a real DEFAULT 1`);
  await pool.query(`ALTER TABLE recipes ADD COLUMN IF NOT EXISTS default_servings_b real DEFAULT 1.5`);
  await pool.query(`UPDATE recipes SET default_servings_a = 1 WHERE default_servings_a IS NULL`);
  await pool.query(`UPDATE recipes SET default_servings_b = 1.5 WHERE default_servings_b IS NULL`);
  await pool.query(`ALTER TABLE recipes ALTER COLUMN default_servings_a SET NOT NULL`);
  await pool.query(`ALTER TABLE recipes ALTER COLUMN default_servings_b SET NOT NULL`);
  await pool.query(`ALTER TABLE recipes ALTER COLUMN default_servings_a SET DEFAULT 1`);
  await pool.query(`ALTER TABLE recipes ALTER COLUMN default_servings_b SET DEFAULT 1.5`);


  // Backward-compatible self-healing for ingredient scaling migration
  await pool.query(`DO $$ BEGIN
    CREATE TYPE ingredient_scaling_type AS ENUM ('LINEAR', 'FIXED', 'STEP', 'FORMULA');
  EXCEPTION
    WHEN duplicate_object THEN null;
  END $$;`);

  await pool.query(`ALTER TABLE recipe_ingredients
    ADD COLUMN IF NOT EXISTS base_amount real,
    ADD COLUMN IF NOT EXISTS alternative_amount real,
    ADD COLUMN IF NOT EXISTS alternative_unit text,
    ADD COLUMN IF NOT EXISTS unit text,
    ADD COLUMN IF NOT EXISTS scaling_type ingredient_scaling_type,
    ADD COLUMN IF NOT EXISTS scaling_formula text,
    ADD COLUMN IF NOT EXISTS step_thresholds jsonb`);

  await pool.query(`UPDATE recipe_ingredients SET base_amount = amount WHERE base_amount IS NULL`);
  await pool.query(`UPDATE recipe_ingredients SET unit = 'g' WHERE unit IS NULL`);
  await pool.query(`UPDATE recipe_ingredients SET scaling_type = 'LINEAR' WHERE scaling_type IS NULL`);

  await pool.query(`ALTER TABLE recipe_ingredients ALTER COLUMN base_amount SET NOT NULL`);
  await pool.query(`ALTER TABLE recipe_ingredients ALTER COLUMN unit SET NOT NULL`);
  await pool.query(`ALTER TABLE recipe_ingredients ALTER COLUMN scaling_type SET NOT NULL`);
  await pool.query(`ALTER TABLE recipe_ingredients ALTER COLUMN scaling_type SET DEFAULT 'LINEAR'`);

  // Backward-compatible self-healing for ingredient block metadata.
  await pool.query(`ALTER TABLE recipe_ingredients
    ADD COLUMN IF NOT EXISTS group_name text`);

  // Backward-compatible self-healing for recipe ingredient meal-prep metadata.
  await pool.query(`ALTER TABLE recipe_ingredients
    ADD COLUMN IF NOT EXISTS meal_prep boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS meal_prep_max_days_before integer DEFAULT 1,
    ADD COLUMN IF NOT EXISTS meal_prep_notes text`);
  await pool.query(`UPDATE recipe_ingredients SET meal_prep = false WHERE meal_prep IS NULL`);
  await pool.query(`UPDATE recipe_ingredients SET meal_prep_max_days_before = 1 WHERE meal_prep_max_days_before IS NULL OR meal_prep_max_days_before < 1`);
  await pool.query(`ALTER TABLE recipe_ingredients ALTER COLUMN meal_prep SET NOT NULL`);
  await pool.query(`ALTER TABLE recipe_ingredients ALTER COLUMN meal_prep SET DEFAULT false`);
  await pool.query(`ALTER TABLE recipe_ingredients ALTER COLUMN meal_prep_max_days_before SET NOT NULL`);
  await pool.query(`ALTER TABLE recipe_ingredients ALTER COLUMN meal_prep_max_days_before SET DEFAULT 1`);

  // Backward-compatible self-healing for frequent addons scaling migration
  await pool.query(`ALTER TABLE recipe_frequent_addons
    ADD COLUMN IF NOT EXISTS base_amount real,
    ADD COLUMN IF NOT EXISTS default_amount_a real,
    ADD COLUMN IF NOT EXISTS default_amount_b real,
    ADD COLUMN IF NOT EXISTS alternative_amount real,
    ADD COLUMN IF NOT EXISTS alternative_unit text,
    ADD COLUMN IF NOT EXISTS unit text,
    ADD COLUMN IF NOT EXISTS scaling_type ingredient_scaling_type,
    ADD COLUMN IF NOT EXISTS scaling_formula text,
    ADD COLUMN IF NOT EXISTS step_thresholds jsonb`);

  await pool.query(`UPDATE recipe_frequent_addons SET base_amount = amount WHERE base_amount IS NULL`);
  await pool.query(`UPDATE recipe_frequent_addons SET default_amount_a = 0 WHERE default_amount_a IS NULL`);
  await pool.query(`UPDATE recipe_frequent_addons SET default_amount_b = base_amount WHERE default_amount_b IS NULL`);
  await pool.query(`UPDATE recipe_frequent_addons SET unit = 'g' WHERE unit IS NULL`);
  await pool.query(`UPDATE recipe_frequent_addons SET scaling_type = 'LINEAR' WHERE scaling_type IS NULL`);

  await pool.query(`ALTER TABLE recipe_frequent_addons ALTER COLUMN base_amount SET NOT NULL`);
  await pool.query(`ALTER TABLE recipe_frequent_addons ALTER COLUMN default_amount_a SET NOT NULL`);
  await pool.query(`ALTER TABLE recipe_frequent_addons ALTER COLUMN default_amount_b SET NOT NULL`);
  await pool.query(`ALTER TABLE recipe_frequent_addons ALTER COLUMN default_amount_a SET DEFAULT 0`);
  await pool.query(`ALTER TABLE recipe_frequent_addons ALTER COLUMN default_amount_b SET DEFAULT 0`);
  await pool.query(`ALTER TABLE recipe_frequent_addons ALTER COLUMN unit SET NOT NULL`);
  await pool.query(`ALTER TABLE recipe_frequent_addons ALTER COLUMN scaling_type SET NOT NULL`);
  await pool.query(`ALTER TABLE recipe_frequent_addons ALTER COLUMN scaling_type SET DEFAULT 'LINEAR'`);

  // Backward-compatible self-healing for per-entry ingredient scaling
  await pool.query(`ALTER TABLE meal_entry_ingredients ADD COLUMN IF NOT EXISTS scaling_type ingredient_scaling_type`);
  await pool.query(`UPDATE meal_entry_ingredients SET scaling_type = 'LINEAR' WHERE scaling_type IS NULL`);
  await pool.query(`ALTER TABLE meal_entry_ingredients ALTER COLUMN scaling_type SET NOT NULL`);
  await pool.query(`ALTER TABLE meal_entry_ingredients ALTER COLUMN scaling_type SET DEFAULT 'LINEAR'`);

  // Backward-compatible self-healing for recipe favorites migration
  await pool.query(`ALTER TABLE recipes ADD COLUMN IF NOT EXISTS is_favorite boolean DEFAULT false`);
  await pool.query(`ALTER TABLE recipes ADD COLUMN IF NOT EXISTS instruction_steps jsonb`);
  await pool.query(`ALTER TABLE recipes ADD COLUMN IF NOT EXISTS suggested_recipe_ids integer[] DEFAULT '{}'::integer[]`);
  await pool.query(`UPDATE recipes SET suggested_recipe_ids = '{}'::integer[] WHERE suggested_recipe_ids IS NULL`);
  await pool.query(`ALTER TABLE recipes ALTER COLUMN suggested_recipe_ids SET NOT NULL`);
  await pool.query(`ALTER TABLE recipes ALTER COLUMN suggested_recipe_ids SET DEFAULT '{}'::integer[]`);
  await pool.query(`ALTER TABLE recipes ADD COLUMN IF NOT EXISTS suggested_recipes jsonb DEFAULT '[]'::jsonb`);
  await pool.query(`UPDATE recipes SET suggested_recipes = '[]'::jsonb WHERE suggested_recipes IS NULL`);
  await pool.query(`UPDATE recipes SET suggested_recipes = COALESCE((
    SELECT jsonb_agg(jsonb_build_object('recipeId', rid, 'servings', 1))
    FROM unnest(suggested_recipe_ids) AS rid
  ), '[]'::jsonb)
  WHERE (suggested_recipes = '[]'::jsonb OR suggested_recipes IS NULL) AND array_length(suggested_recipe_ids, 1) > 0`);
  await pool.query(`ALTER TABLE recipes ALTER COLUMN suggested_recipes SET NOT NULL`);
  await pool.query(`ALTER TABLE recipes ALTER COLUMN suggested_recipes SET DEFAULT '[]'::jsonb`);
  await pool.query(`UPDATE recipes SET is_favorite = false WHERE is_favorite IS NULL`);
  await pool.query(`ALTER TABLE recipes ALTER COLUMN is_favorite SET NOT NULL`);
  await pool.query(`ALTER TABLE recipes ALTER COLUMN is_favorite SET DEFAULT false`);

  await pool.query(`CREATE TABLE IF NOT EXISTS shopping_list_checks (
    ingredient_id integer NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    is_checked boolean NOT NULL DEFAULT false,
    updated_at timestamp DEFAULT now(),
    PRIMARY KEY (ingredient_id, period_start, period_end)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS shopping_list_extras (
    id serial PRIMARY KEY,
    period_start date NOT NULL,
    period_end date NOT NULL,
    name text NOT NULL,
    amount real NOT NULL DEFAULT 1,
    unit text NOT NULL DEFAULT 'szt',
    category text NOT NULL DEFAULT 'Dodatkowe',
    is_checked boolean NOT NULL DEFAULT false,
    created_at timestamp DEFAULT now()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS shopping_list_excluded_items (
    ingredient_id integer NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    updated_at timestamp DEFAULT now(),
    PRIMARY KEY (ingredient_id, period_start, period_end)
  )`);

  await pool.query(`ALTER TABLE shopping_list_checks ADD COLUMN IF NOT EXISTS period_start date`);
  await pool.query(`ALTER TABLE shopping_list_checks ADD COLUMN IF NOT EXISTS period_end date`);
  await pool.query(`UPDATE shopping_list_checks SET period_start = CURRENT_DATE, period_end = CURRENT_DATE WHERE period_start IS NULL OR period_end IS NULL`);
  await pool.query(`ALTER TABLE shopping_list_checks ALTER COLUMN period_start SET NOT NULL`);
  await pool.query(`ALTER TABLE shopping_list_checks ALTER COLUMN period_end SET NOT NULL`);
  await pool.query(`DELETE FROM shopping_list_checks a USING shopping_list_checks b WHERE a.ctid < b.ctid AND a.ingredient_id = b.ingredient_id AND a.period_start = b.period_start AND a.period_end = b.period_end`);
  await pool.query(`ALTER TABLE shopping_list_checks DROP CONSTRAINT IF EXISTS shopping_list_checks_pkey`);
  await pool.query(`ALTER TABLE shopping_list_checks ADD CONSTRAINT shopping_list_checks_pkey PRIMARY KEY (ingredient_id, period_start, period_end)`);

  await pool.query(`ALTER TABLE shopping_list_extras ADD COLUMN IF NOT EXISTS period_start date`);
  await pool.query(`ALTER TABLE shopping_list_extras ADD COLUMN IF NOT EXISTS period_end date`);
  await pool.query(`UPDATE shopping_list_extras SET period_start = CURRENT_DATE, period_end = CURRENT_DATE WHERE period_start IS NULL OR period_end IS NULL`);
  await pool.query(`ALTER TABLE shopping_list_extras ALTER COLUMN period_start SET NOT NULL`);
  await pool.query(`ALTER TABLE shopping_list_extras ALTER COLUMN period_end SET NOT NULL`);

  await pool.query(`ALTER TABLE shopping_list_extras ADD COLUMN IF NOT EXISTS amount real DEFAULT 1`);
  await pool.query(`UPDATE shopping_list_extras SET amount = 1 WHERE amount IS NULL`);
  await pool.query(`ALTER TABLE shopping_list_extras ALTER COLUMN amount SET NOT NULL`);
  await pool.query(`ALTER TABLE shopping_list_extras ALTER COLUMN amount SET DEFAULT 1`);

  await pool.query(`ALTER TABLE shopping_list_extras ADD COLUMN IF NOT EXISTS unit text DEFAULT 'szt'`);
  await pool.query(`UPDATE shopping_list_extras SET unit = 'szt' WHERE unit IS NULL`);
  await pool.query(`ALTER TABLE shopping_list_extras ALTER COLUMN unit SET NOT NULL`);
  await pool.query(`ALTER TABLE shopping_list_extras ALTER COLUMN unit SET DEFAULT 'szt'`);

  await pool.query(`ALTER TABLE shopping_list_extras ADD COLUMN IF NOT EXISTS category text DEFAULT 'Dodatkowe'`);
  await pool.query(`UPDATE shopping_list_extras SET category = 'Dodatkowe' WHERE category IS NULL`);
  await pool.query(`ALTER TABLE shopping_list_extras ALTER COLUMN category SET NOT NULL`);
  await pool.query(`ALTER TABLE shopping_list_extras ALTER COLUMN category SET DEFAULT 'Dodatkowe'`);

  await pool.query(`ALTER TABLE shopping_list_extras ADD COLUMN IF NOT EXISTS is_checked boolean DEFAULT false`);
  await pool.query(`UPDATE shopping_list_extras SET is_checked = false WHERE is_checked IS NULL`);
  await pool.query(`ALTER TABLE shopping_list_extras ALTER COLUMN is_checked SET NOT NULL`);
  await pool.query(`ALTER TABLE shopping_list_extras ALTER COLUMN is_checked SET DEFAULT false`);

  await pool.query(`ALTER TABLE shopping_list_extras ADD COLUMN IF NOT EXISTS created_at timestamp DEFAULT now()`);

  await pool.query(`ALTER TABLE shopping_list_excluded_items ADD COLUMN IF NOT EXISTS period_start date`);
  await pool.query(`ALTER TABLE shopping_list_excluded_items ADD COLUMN IF NOT EXISTS period_end date`);
  await pool.query(`UPDATE shopping_list_excluded_items SET period_start = CURRENT_DATE, period_end = CURRENT_DATE WHERE period_start IS NULL OR period_end IS NULL`);
  await pool.query(`ALTER TABLE shopping_list_excluded_items ALTER COLUMN period_start SET NOT NULL`);
  await pool.query(`ALTER TABLE shopping_list_excluded_items ALTER COLUMN period_end SET NOT NULL`);
  await pool.query(`DELETE FROM shopping_list_excluded_items a USING shopping_list_excluded_items b WHERE a.ctid < b.ctid AND a.ingredient_id = b.ingredient_id AND a.period_start = b.period_start AND a.period_end = b.period_end`);
  await pool.query(`ALTER TABLE shopping_list_excluded_items DROP CONSTRAINT IF EXISTS shopping_list_excluded_items_pkey`);
  await pool.query(`ALTER TABLE shopping_list_excluded_items ADD CONSTRAINT shopping_list_excluded_items_pkey PRIMARY KEY (ingredient_id, period_start, period_end)`);

  await pool.query(`CREATE TABLE IF NOT EXISTS shopping_list_snapshots (
    id serial PRIMARY KEY,
    name text NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    created_at timestamp DEFAULT now()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS shopping_list_snapshot_items (
    id serial PRIMARY KEY,
    snapshot_id integer NOT NULL REFERENCES shopping_list_snapshots(id) ON DELETE CASCADE,
    ingredient_id integer,
    name text NOT NULL,
    total_amount real NOT NULL DEFAULT 0,
    unit text NOT NULL DEFAULT 'g',
    category text NOT NULL DEFAULT 'Inne',
    status text NOT NULL DEFAULT 'NOT_BOUGHT',
    price real NOT NULL DEFAULT 0,
    is_extra boolean NOT NULL DEFAULT false
  )`);

  await pool.query(`ALTER TABLE shopping_list_snapshot_items ADD COLUMN IF NOT EXISTS ingredient_id integer`);
  await pool.query(`ALTER TABLE shopping_list_snapshot_items ADD COLUMN IF NOT EXISTS total_amount real DEFAULT 0`);
  await pool.query(`UPDATE shopping_list_snapshot_items SET total_amount = 0 WHERE total_amount IS NULL`);
  await pool.query(`ALTER TABLE shopping_list_snapshot_items ALTER COLUMN total_amount SET NOT NULL`);
  await pool.query(`ALTER TABLE shopping_list_snapshot_items ALTER COLUMN total_amount SET DEFAULT 0`);

  await pool.query(`ALTER TABLE shopping_list_snapshot_items ADD COLUMN IF NOT EXISTS unit text DEFAULT 'g'`);
  await pool.query(`UPDATE shopping_list_snapshot_items SET unit = 'g' WHERE unit IS NULL`);
  await pool.query(`ALTER TABLE shopping_list_snapshot_items ALTER COLUMN unit SET NOT NULL`);
  await pool.query(`ALTER TABLE shopping_list_snapshot_items ALTER COLUMN unit SET DEFAULT 'g'`);

  await pool.query(`ALTER TABLE shopping_list_snapshot_items ADD COLUMN IF NOT EXISTS category text DEFAULT 'Inne'`);
  await pool.query(`UPDATE shopping_list_snapshot_items SET category = 'Inne' WHERE category IS NULL`);
  await pool.query(`ALTER TABLE shopping_list_snapshot_items ALTER COLUMN category SET NOT NULL`);
  await pool.query(`ALTER TABLE shopping_list_snapshot_items ALTER COLUMN category SET DEFAULT 'Inne'`);

  await pool.query(`ALTER TABLE shopping_list_snapshot_items ADD COLUMN IF NOT EXISTS status text DEFAULT 'NOT_BOUGHT'`);
  await pool.query(`UPDATE shopping_list_snapshot_items SET status = 'NOT_BOUGHT' WHERE status IS NULL`);
  await pool.query(`ALTER TABLE shopping_list_snapshot_items ALTER COLUMN status SET NOT NULL`);
  await pool.query(`ALTER TABLE shopping_list_snapshot_items ALTER COLUMN status SET DEFAULT 'NOT_BOUGHT'`);

  await pool.query(`ALTER TABLE shopping_list_snapshot_items ADD COLUMN IF NOT EXISTS price real DEFAULT 0`);
  await pool.query(`UPDATE shopping_list_snapshot_items SET price = 0 WHERE price IS NULL`);
  await pool.query(`ALTER TABLE shopping_list_snapshot_items ALTER COLUMN price SET NOT NULL`);
  await pool.query(`ALTER TABLE shopping_list_snapshot_items ALTER COLUMN price SET DEFAULT 0`);

  await pool.query(`ALTER TABLE shopping_list_snapshot_items ADD COLUMN IF NOT EXISTS is_extra boolean DEFAULT false`);
  await pool.query(`UPDATE shopping_list_snapshot_items SET is_extra = false WHERE is_extra IS NULL`);
  await pool.query(`ALTER TABLE shopping_list_snapshot_items ALTER COLUMN is_extra SET NOT NULL`);
  await pool.query(`ALTER TABLE shopping_list_snapshot_items ALTER COLUMN is_extra SET DEFAULT false`);

  await pool.query(`ALTER TABLE shopping_list_snapshots ADD COLUMN IF NOT EXISTS created_at timestamp DEFAULT now()`);
  await pool.query(`ALTER TABLE shopping_list_snapshot_items ADD COLUMN IF NOT EXISTS created_at timestamp DEFAULT now()`);

  await pool.query(`ALTER TABLE shopping_list_snapshots ADD COLUMN IF NOT EXISTS status text DEFAULT 'ACTIVE'`);
  await pool.query(`UPDATE shopping_list_snapshots SET status = 'ACTIVE' WHERE status IS NULL`);
  await pool.query(`ALTER TABLE shopping_list_snapshots ALTER COLUMN status SET NOT NULL`);
  await pool.query(`ALTER TABLE shopping_list_snapshots ALTER COLUMN status SET DEFAULT 'ACTIVE'`);

  await pool.query(`ALTER TABLE shopping_list_snapshots ADD COLUMN IF NOT EXISTS completed_at timestamp`);


  await pool.query(`CREATE TABLE IF NOT EXISTS recipe_prep_tasks (
    id serial PRIMARY KEY,
    recipe_id integer NOT NULL,
    title text NOT NULL,
    ingredient_id integer,
    ingredient_source text NOT NULL DEFAULT 'ingredient',
    max_days_before integer NOT NULL DEFAULT 1,
    group_key text,
    notes text,
    created_at timestamp DEFAULT now()
  )`);
  await pool.query(`ALTER TABLE recipe_prep_tasks ADD COLUMN IF NOT EXISTS ingredient_id integer`);
  await pool.query(`ALTER TABLE recipe_prep_tasks ADD COLUMN IF NOT EXISTS ingredient_source text DEFAULT 'ingredient'`);
  await pool.query(`ALTER TABLE recipe_prep_tasks ADD COLUMN IF NOT EXISTS max_days_before integer DEFAULT 1`);
  await pool.query(`ALTER TABLE recipe_prep_tasks ADD COLUMN IF NOT EXISTS group_key text`);
  await pool.query(`ALTER TABLE recipe_prep_tasks ADD COLUMN IF NOT EXISTS notes text`);
  await pool.query(`ALTER TABLE recipe_prep_tasks ADD COLUMN IF NOT EXISTS created_at timestamp DEFAULT now()`);
  await pool.query(`UPDATE recipe_prep_tasks SET ingredient_source = 'ingredient' WHERE ingredient_source IS NULL`);
  await pool.query(`UPDATE recipe_prep_tasks SET max_days_before = 1 WHERE max_days_before IS NULL OR max_days_before < 1`);
  await pool.query(`ALTER TABLE recipe_prep_tasks ALTER COLUMN ingredient_source SET NOT NULL`);
  await pool.query(`ALTER TABLE recipe_prep_tasks ALTER COLUMN ingredient_source SET DEFAULT 'ingredient'`);
  await pool.query(`ALTER TABLE recipe_prep_tasks ALTER COLUMN max_days_before SET NOT NULL`);
  await pool.query(`ALTER TABLE recipe_prep_tasks ALTER COLUMN max_days_before SET DEFAULT 1`);
  await pool.query(`CREATE INDEX IF NOT EXISTS recipe_prep_tasks_recipe_id_idx ON recipe_prep_tasks(recipe_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS recipe_prep_tasks_ingredient_id_idx ON recipe_prep_tasks(ingredient_id)`);

  await pool.query(`CREATE TABLE IF NOT EXISTS shared_meal_batches (
    id serial PRIMARY KEY,
    recipe_id integer NOT NULL,
    total_servings real NOT NULL DEFAULT 1,
    note text,
    recipe_snapshot jsonb,
    is_archived boolean NOT NULL DEFAULT false,
    created_at timestamp DEFAULT now()
  )`);

  await pool.query(`ALTER TABLE meal_entries ADD COLUMN IF NOT EXISTS cooked_batch_id integer`);
  await pool.query(`ALTER TABLE meal_entries ADD COLUMN IF NOT EXISTS recipe_snapshot jsonb`);
  // Keep runtime compatibility aligned with migration 0011 even when SQL
  // migrations have not been applied by the deployment platform.
  await pool.query(`ALTER TABLE meal_entries ADD COLUMN IF NOT EXISTS consumed_weight_grams real`);
  await pool.query(`ALTER TABLE shared_meal_batches ADD COLUMN IF NOT EXISTS recipe_snapshot jsonb`);
  await pool.query(`ALTER TABLE shared_meal_batches ADD COLUMN IF NOT EXISTS finished_weight_grams real`);

  await pool.query(`CREATE TABLE IF NOT EXISTS shared_meal_batch_logs (
    id serial PRIMARY KEY,
    batch_id integer NOT NULL,
    action text NOT NULL,
    payload jsonb,
    created_at timestamp DEFAULT now()
  )`);


}
