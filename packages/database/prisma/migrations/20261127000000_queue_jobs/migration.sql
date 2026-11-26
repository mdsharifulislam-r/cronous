-- Queue jobs: named admission lanes (concurrency, priority, pause), immediate and
-- delayed submissions (trigger QUEUE), per-execution retry settings, payload schemas.
-- Written to be safe on populated databases: columns are backfilled before NOT NULL.

-- AlterEnum (the new value is not used inside this migration)
ALTER TYPE "ExecutionTrigger" ADD VALUE 'QUEUE';

-- Queues ---------------------------------------------------------------------------
CREATE TABLE "queues" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "concurrency_limit" INTEGER,
    "default_priority" INTEGER NOT NULL DEFAULT 50,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "queues_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "queues_concurrency_limit_check" CHECK ("concurrency_limit" IS NULL OR "concurrency_limit" >= 1),
    CONSTRAINT "queues_default_priority_check" CHECK ("default_priority" BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX "queues_project_id_name_key" ON "queues"("project_id", "name");
ALTER TABLE "queues" ADD CONSTRAINT "queues_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every project gets its "default" queue (new projects get one from the application).
INSERT INTO "queues" ("id", "project_id", "name", "updated_at")
SELECT gen_random_uuid(), "id", 'default', CURRENT_TIMESTAMP FROM "projects";

-- Jobs -----------------------------------------------------------------------------
ALTER TABLE "jobs"
    ADD COLUMN "queue_id" UUID,
    ADD COLUMN "max_concurrency" INTEGER,
    ADD COLUMN "priority" INTEGER,
    ADD COLUMN "payload_schema" JSONB;
UPDATE "jobs" j SET "queue_id" = q."id" FROM "queues" q WHERE q."project_id" = j."project_id" AND q."name" = 'default';
ALTER TABLE "jobs" ALTER COLUMN "queue_id" SET NOT NULL;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_max_concurrency_check" CHECK ("max_concurrency" IS NULL OR "max_concurrency" >= 1);
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_priority_check" CHECK ("priority" IS NULL OR "priority" BETWEEN 0 AND 100);
CREATE INDEX "jobs_queue_id_idx" ON "jobs"("queue_id");
-- NO ACTION (end-of-statement check): a project delete cascades to jobs and queues together.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Executions -----------------------------------------------------------------------
ALTER TABLE "job_executions"
    ADD COLUMN "queue_id" UUID,
    ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 50,
    ADD COLUMN "retry_backoff_ms" INTEGER,
    ADD COLUMN "retry_backoff_max_ms" INTEGER;
UPDATE "job_executions" e
SET "queue_id" = j."queue_id", "retry_backoff_ms" = j."retry_backoff_ms", "retry_backoff_max_ms" = j."retry_backoff_max_ms"
FROM "jobs" j WHERE j."id" = e."job_id";
ALTER TABLE "job_executions" ALTER COLUMN "retry_backoff_ms" SET NOT NULL;
ALTER TABLE "job_executions" ALTER COLUMN "retry_backoff_max_ms" SET NOT NULL;
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_priority_check" CHECK ("priority" BETWEEN 0 AND 100);
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "job_executions_status_priority_next_attempt_at_idx" ON "job_executions"("status", "priority" DESC, "next_attempt_at");
CREATE INDEX "job_executions_queue_id_status_idx" ON "job_executions"("queue_id", "status");
CREATE INDEX "job_executions_job_id_status_idx" ON "job_executions"("job_id", "status");
