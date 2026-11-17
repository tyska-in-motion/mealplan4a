ALTER TABLE "ingredients"
  ADD COLUMN IF NOT EXISTS "sugar" real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fiber" real NOT NULL DEFAULT 0;

ALTER TABLE "meal_entries"
  ADD COLUMN IF NOT EXISTS "custom_sugar" real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "custom_fiber" real NOT NULL DEFAULT 0;

ALTER TABLE "user_settings"
  ADD COLUMN IF NOT EXISTS "target_sugar_min" real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "target_sugar_max" real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "target_fiber_min" real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "target_fiber_max" real NOT NULL DEFAULT 0;

ALTER TABLE "user_settings_history"
  ADD COLUMN IF NOT EXISTS "target_sugar_min" real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "target_sugar_max" real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "target_fiber_min" real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "target_fiber_max" real NOT NULL DEFAULT 0;
