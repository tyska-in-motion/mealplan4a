ALTER TABLE ingredients
  ADD COLUMN IF NOT EXISTS produce_type text;

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS target_vegetables real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS target_fruits real NOT NULL DEFAULT 0;

ALTER TABLE user_settings_history
  ADD COLUMN IF NOT EXISTS target_vegetables real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS target_fruits real NOT NULL DEFAULT 0;

ALTER TABLE ingredients
  ADD CONSTRAINT ingredients_produce_type_check
  CHECK (produce_type IS NULL OR produce_type IN ('vegetable', 'fruit'));
