import { api } from '@/lib/api/client';
import type { ExecutionMode, Job, JobInput, JobSource, SubmissionResult } from '@/types/api';

export interface JobListFilters {
  q?: string;
  mode?: ExecutionMode;
  enabled?: boolean;
  source?: JobSource;
  queue?: string;
}

export const jobsService = {
  list: (projectId: string, filters: JobListFilters = {}) => api.get<Job[]>(`/projects/${projectId}/jobs`, { ...filters }),
  get: (projectId: string, jobId: string) => api.get<Job>(`/projects/${projectId}/jobs/${jobId}`),
  create: (projectId: string, input: JobInput) => api.post<Job>(`/projects/${projectId}/jobs`, input),
  update: (projectId: string, jobId: string, input: JobInput) => api.patch<Job>(`/projects/${projectId}/jobs/${jobId}`, input),
  remove: (projectId: string, jobId: string) => api.delete(`/projects/${projectId}/jobs/${jobId}`),
  pause: (projectId: string, jobId: string) => api.post<Job>(`/projects/${projectId}/jobs/${jobId}/pause`),
  resume: (projectId: string, jobId: string) => api.post<Job>(`/projects/${projectId}/jobs/${jobId}/resume`),
  /** "Run now" (trigger MANUAL). */
  trigger: (projectId: string, jobId: string, input: { payload?: unknown; idempotencyKey?: string } = {}) =>
    api.post<SubmissionResult>(`/projects/${projectId}/jobs/${jobId}/trigger`, input),
};
