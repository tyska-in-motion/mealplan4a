-- Existing recipes stay in shared mode; no historical serving data is converted.
ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS portioning_mode text NOT NULL DEFAULT 'shared',
  ADD COLUMN IF NOT EXISTS default_variant_a text NOT NULL DEFAULT 'B',
  ADD COLUMN IF NOT EXISTS default_variant_b text NOT NULL DEFAULT 'B';

ALTER TABLE recipe_ingredients
  ADD COLUMN IF NOT EXISTS variant_amount_a real,
  ADD COLUMN IF NOT EXISTS variant_amount_b real,
  ADD COLUMN IF NOT EXISTS variant_amount_c real;

ALTER TABLE meal_entries
  ADD COLUMN IF NOT EXISTS portion_variant text,
  ADD COLUMN IF NOT EXISTS ingredients_modified boolean NOT NULL DEFAULT false;

ALTER TABLE recipes
  ADD CONSTRAINT recipes_portioning_mode_check
  CHECK (portioning_mode IN ('shared', 'individual'))
  NOT VALID;

ALTER TABLE recipes
  ADD CONSTRAINT recipes_default_variant_a_check
  CHECK (default_variant_a IN ('A', 'B', 'C'))
  NOT VALID;

ALTER TABLE recipes
  ADD CONSTRAINT recipes_default_variant_b_check
  CHECK (default_variant_b IN ('A', 'B', 'C'))
  NOT VALID;
