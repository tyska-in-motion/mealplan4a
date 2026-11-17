ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS calorie_goal_mode text NOT NULL DEFAULT 'maintenance';

ALTER TABLE user_settings_history
  ADD COLUMN IF NOT EXISTS calorie_goal_mode text NOT NULL DEFAULT 'maintenance';

ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_calorie_goal_mode_check
  CHECK (calorie_goal_mode IN ('cut', 'bulk', 'maintenance'));

ALTER TABLE user_settings_history
  ADD CONSTRAINT user_settings_history_calorie_goal_mode_check
  CHECK (calorie_goal_mode IN ('cut', 'bulk', 'maintenance'));
