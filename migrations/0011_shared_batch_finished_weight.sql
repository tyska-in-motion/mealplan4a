ALTER TABLE shared_meal_batches
  ADD COLUMN IF NOT EXISTS finished_weight_grams real;

ALTER TABLE meal_entries
  ADD COLUMN IF NOT EXISTS consumed_weight_grams real;
