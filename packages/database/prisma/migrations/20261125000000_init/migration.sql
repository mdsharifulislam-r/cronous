-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('USER', 'PROJECT', 'AGENT');

-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('HTTP', 'AGENT', 'WORKER');

-- CreateEnum
CREATE TYPE "JobSource" AS ENUM ('API', 'SDK');

-- CreateEnum
CREATE TYPE "ConcurrencyPolicy" AS ENUM ('ALLOW', 'FORBID');

-- CreateEnum
CREATE TYPE "ScheduleType" AS ENUM ('CRON', 'ONCE');

-- CreateEnum
CREATE TYPE "ScheduleState" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "MisfirePolicy" AS ENUM ('FIRE_ONCE', 'SKIP', 'FIRE_ALL');

-- CreateEnum
CREATE TYPE "ExecutionTrigger" AS ENUM ('SCHEDULE', 'MANUAL');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABANDONED');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "ExecutorStatus" AS ENUM ('ONLINE', 'DRAINING', 'OFFLINE');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'CREDENTIAL', 'SYSTEM');

-- CreateTable
CREATE TABLE "system_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "bootstrap_token_hash" TEXT,
    "bootstrapped_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "system_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "OrgRole" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_credentials" (
    "id" UUID NOT NULL,
    "kind" "CredentialKind" NOT NULL,
    "name" TEXT NOT NULL,
    "display_prefix" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID,
    "project_id" UUID,
    "created_by_user_id" UUID,
    "rotated_from_id" UUID,
    "expires_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "mode" "ExecutionMode" NOT NULL,
    "source" "JobSource" NOT NULL DEFAULT 'API',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "http_config" JSONB,
    "payload" JSONB,
    "timeout_ms" INTEGER NOT NULL DEFAULT 300000,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "retry_backoff_ms" INTEGER NOT NULL DEFAULT 10000,
    "retry_backoff_max_ms" INTEGER NOT NULL DEFAULT 3600000,
    "concurrency_policy" "ConcurrencyPolicy" NOT NULL DEFAULT 'ALLOW',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_schedules" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "type" "ScheduleType" NOT NULL,
    "cron_expression" TEXT,
    "run_at" TIMESTAMPTZ(3),
    "timezone" TEXT NOT NULL,
    "state" "ScheduleState" NOT NULL DEFAULT 'ACTIVE',
    "misfire_policy" "MisfirePolicy" NOT NULL DEFAULT 'FIRE_ONCE',
    "misfire_grace_ms" INTEGER NOT NULL DEFAULT 60000,
    "max_catch_up" INTEGER NOT NULL DEFAULT 10,
    "next_run_at" TIMESTAMPTZ(3),
    "last_scheduled_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_executions" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "trigger" "ExecutionTrigger" NOT NULL,
    "scheduled_for" TIMESTAMPTZ(3) NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" TEXT NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "payload" JSONB,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "timeout_ms" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(3),
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_attempts" (
    "id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'RUNNING',
    "agent_id" UUID,
    "worker_id" UUID,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "lease_expires_at" TIMESTAMPTZ(3),
    "error_code" TEXT,
    "error_message" TEXT,
    "http_status" INTEGER,
    "output" JSONB,

    CONSTRAINT "job_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_logs" (
    "id" BIGSERIAL NOT NULL,
    "execution_id" UUID NOT NULL,
    "attempt_id" UUID,
    "level" "LogLevel" NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "credential_id" UUID,
    "instance_id" TEXT NOT NULL,
    "hostname" TEXT,
    "sdk_version" TEXT NOT NULL,
    "protocol_version" INTEGER NOT NULL,
    "status" "ExecutorStatus" NOT NULL DEFAULT 'ONLINE',
    "handlers" TEXT[],
    "metadata" JSONB,
    "connected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_heartbeat_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnected_at" TIMESTAMPTZ(3),

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workers" (
    "id" UUID NOT NULL,
    "instance_id" TEXT NOT NULL,
    "hostname" TEXT,
    "version" TEXT NOT NULL,
    "status" "ExecutorStatus" NOT NULL DEFAULT 'ONLINE',
    "concurrency" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_heartbeat_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stopped_at" TIMESTAMPTZ(3),

    CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "organization_id" UUID,
    "project_id" UUID,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "metadata" JSONB,
    "request_id" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_organization_id_user_id_key" ON "memberships"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_organization_id_slug_key" ON "projects"("organization_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "api_credentials_token_hash_key" ON "api_credentials"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "api_credentials_rotated_from_id_key" ON "api_credentials"("rotated_from_id");

-- CreateIndex
CREATE INDEX "api_credentials_project_id_kind_idx" ON "api_credentials"("project_id", "kind");

-- CreateIndex
CREATE INDEX "api_credentials_user_id_idx" ON "api_credentials"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_project_id_name_key" ON "jobs"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "job_schedules_job_id_key" ON "job_schedules"("job_id");

-- CreateIndex
CREATE INDEX "job_schedules_state_next_run_at_idx" ON "job_schedules"("state", "next_run_at");

-- CreateIndex
CREATE INDEX "job_executions_status_next_attempt_at_idx" ON "job_executions"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "job_executions_status_lease_expires_at_idx" ON "job_executions"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "job_executions_project_id_created_at_idx" ON "job_executions"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "job_executions_job_id_created_at_idx" ON "job_executions"("job_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "job_executions_job_id_idempotency_key_key" ON "job_executions"("job_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "job_attempts_execution_id_attempt_number_key" ON "job_attempts"("execution_id", "attempt_number");

-- CreateIndex
CREATE INDEX "execution_logs_execution_id_id_idx" ON "execution_logs"("execution_id", "id");

-- CreateIndex
CREATE INDEX "agents_project_id_status_idx" ON "agents"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agents_project_id_instance_id_key" ON "agents"("project_id", "instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "workers_instance_id_key" ON "workers"("instance_id");

-- CreateIndex
CREATE INDEX "workers_status_last_heartbeat_at_idx" ON "workers"("status", "last_heartbeat_at");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_rotated_from_id_fkey" FOREIGN KEY ("rotated_from_id") REFERENCES "api_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_schedules" ADD CONSTRAINT "job_schedules_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "job_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "job_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "job_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "api_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constraints Prisma cannot express in the schema language
-- ---------------------------------------------------------------------------

-- A credential is owned by exactly the principal its kind implies.
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_owner_check" CHECK (
  ("kind" = 'USER' AND "user_id" IS NOT NULL AND "project_id" IS NULL)
  OR ("kind" IN ('PROJECT', 'AGENT') AND "project_id" IS NOT NULL AND "user_id" IS NULL)
);

-- A schedule carries exactly the field its type needs.
ALTER TABLE "job_schedules" ADD CONSTRAINT "job_schedules_shape_check" CHECK (
  ("type" = 'CRON' AND "cron_expression" IS NOT NULL AND "run_at" IS NULL)
  OR ("type" = 'ONCE' AND "run_at" IS NOT NULL AND "cron_expression" IS NULL)
);
ALTER TABLE "job_schedules" ADD CONSTRAINT "job_schedules_limits_check" CHECK (
  "misfire_grace_ms" >= 0 AND "max_catch_up" BETWEEN 1 AND 1000 AND "version" >= 1
);

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_limits_check" CHECK (
  "timeout_ms" > 0 AND "max_attempts" BETWEEN 1 AND 100
  AND "retry_backoff_ms" >= 0 AND "retry_backoff_max_ms" >= "retry_backoff_ms"
);
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_http_config_check" CHECK (
  "mode" <> 'HTTP' OR "http_config" IS NOT NULL
);

ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_attempts_check" CHECK (
  "attempt_count" >= 0 AND "max_attempts" >= 1 AND "timeout_ms" > 0
);
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_number_check" CHECK ("attempt_number" >= 1);
ALTER TABLE "workers" ADD CONSTRAINT "workers_concurrency_check" CHECK ("concurrency" >= 1);

-- Singleton installation state row.
ALTER TABLE "system_state" ADD CONSTRAINT "system_state_singleton_check" CHECK ("id" = 1);
INSERT INTO "system_state" ("id", "created_at", "updated_at") VALUES (1, now(), now()) ON CONFLICT ("id") DO NOTHING;
