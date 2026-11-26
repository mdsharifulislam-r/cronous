-- Dashboard support: change feed for real-time execution events, and project-scoped
-- activity log queries.
CREATE INDEX "job_executions_project_id_updated_at_idx" ON "job_executions"("project_id", "updated_at");
CREATE INDEX "audit_logs_project_id_created_at_idx" ON "audit_logs"("project_id", "created_at" DESC);
