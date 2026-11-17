-- Existing exclusions were shared by both people. Copy them so their prior
-- meaning is retained before making the exclusion key person-specific.
ALTER TABLE stats_day_exclusions ADD COLUMN IF NOT EXISTS person text;
UPDATE stats_day_exclusions SET person = 'A' WHERE person IS NULL;
ALTER TABLE stats_day_exclusions DROP CONSTRAINT IF EXISTS stats_day_exclusions_pkey;
ALTER TABLE stats_day_exclusions ALTER COLUMN person SET NOT NULL;
INSERT INTO stats_day_exclusions (date, person, reason, updated_at)
SELECT date, 'B', reason, updated_at
FROM stats_day_exclusions
WHERE person = 'A'
ON CONFLICT DO NOTHING;

-- If a previous attempt copied B rows but failed before it could add the
-- primary key, retrying the migration creates duplicate (date, person) rows.
-- Keep one row from each pair so this migration can safely be rerun.
DELETE FROM stats_day_exclusions AS duplicate
USING stats_day_exclusions AS retained
WHERE duplicate.date = retained.date
  AND duplicate.person = retained.person
  AND duplicate.ctid < retained.ctid;

ALTER TABLE stats_day_exclusions
  ADD CONSTRAINT stats_day_exclusions_pkey PRIMARY KEY (date, person);
