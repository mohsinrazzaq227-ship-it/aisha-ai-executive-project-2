-- 002_task_graph.sql — task-graph scheduling (dependencies, parallel batches, resource classes)
-- Idempotent: safe to apply on an existing installation and on a fresh database.
ALTER TABLE plan_steps ADD COLUMN IF NOT EXISTS depends_on jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE plan_steps ADD COLUMN IF NOT EXISTS parallel boolean NOT NULL DEFAULT false;
ALTER TABLE plan_steps ADD COLUMN IF NOT EXISTS resource_class text NOT NULL DEFAULT 'LIGHT';
ALTER TABLE plan_steps ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS plan_steps_dep_idx ON plan_steps (task_id, step_index);
