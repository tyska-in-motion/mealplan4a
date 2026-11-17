ALTER TABLE ingredients
  ADD COLUMN IF NOT EXISTS produce_percentage real NOT NULL DEFAULT 100;

ALTER TABLE ingredients
  DROP CONSTRAINT IF EXISTS ingredients_produce_type_check;

ALTER TABLE ingredients
  ADD CONSTRAINT ingredients_produce_type_check
  CHECK (produce_type IS NULL OR produce_type IN ('vegetable', 'fruit', 'none'));
