import { api } from '@/lib/api/client';
import type { Queue, QueueSubmissionInput, SubmissionResult, SubmittedExecution } from '@/types/api';

export interface BatchResult {
  results: { index: number; outcome: 'created' | 'duplicate' | 'error'; execution?: SubmittedExecution; error?: { status: number; code: string; message: string } }[];
  summary: { created: number; duplicate: number; failed: number };
}

export const queuesService = {
  list: (projectId: string) => api.get<Queue[]>(`/projects/${projectId}/queues`),
  get: (projectId: string, name: string) => api.get<Queue>(`/projects/${projectId}/queues/${encodeURIComponent(name)}`),
  create: (projectId: string, input: { name: string; description?: string | null; concurrencyLimit?: number | null; defaultPriority?: number }) =>
    api.post<Queue>(`/projects/${projectId}/queues`, input),
  update: (projectId: string, name: string, input: { description?: string | null; concurrencyLimit?: number | null; defaultPriority?: number }) =>
    api.patch<Queue>(`/projects/${projectId}/queues/${encodeURIComponent(name)}`, input),
  remove: (projectId: string, name: string) => api.delete(`/projects/${projectId}/queues/${encodeURIComponent(name)}`),
  pause: (projectId: string, name: string) => api.post<Queue>(`/projects/${projectId}/queues/${encodeURIComponent(name)}/pause`),
  resume: (projectId: string, name: string) => api.post<Queue>(`/projects/${projectId}/queues/${encodeURIComponent(name)}/resume`),
  /** Immediate (no delay) or delayed (delayMs / runAt) submission. */
  submit: (projectId: string, input: QueueSubmissionInput) => api.post<SubmissionResult>(`/projects/${projectId}/queue`, input),
  submitBatch: (projectId: string, items: QueueSubmissionInput[]) => api.post<BatchResult>(`/projects/${projectId}/queue/batch`, { items }),
};
