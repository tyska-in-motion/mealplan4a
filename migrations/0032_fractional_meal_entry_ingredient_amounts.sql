-- Per-entry quantities can be fractional (for example 12.5 g). This is a
-- widening conversion and preserves all existing integer values.
ALTER TABLE meal_entry_ingredients
  ALTER COLUMN amount TYPE real USING amount::real;
