import { api } from '@/lib/api/client';
import type { ExecutionDetail, ExecutionFilters, ExecutionLog, ExecutionMode, ExecutionStatus, Page, ExecutionSummary, ProjectStats, Timeseries } from '@/types/api';

export const executionsService = {
  list: (projectId: string, filters: ExecutionFilters = {}, signal?: AbortSignal) =>
    api.get<Page<ExecutionSummary>>(`/projects/${projectId}/executions`, { ...filters, status: filters.status }, signal),
  get: (projectId: string, executionId: string) => api.get<ExecutionDetail>(`/projects/${projectId}/executions/${executionId}`),
  logs: (projectId: string, executionId: string, afterId?: string, limit = 500) =>
    api.get<{ items: ExecutionLog[]; nextAfterId: string | null }>(`/projects/${projectId}/executions/${executionId}/logs`, { afterId, limit }),
  cancel: (projectId: string, executionId: string) =>
    api.post<{ id: string; status: 'CANCELLED'; previousStatus: ExecutionStatus }>(`/projects/${projectId}/executions/${executionId}/cancel`),
  retry: (projectId: string, executionId: string) => api.post<{ id: string; status: 'PENDING' }>(`/projects/${projectId}/executions/${executionId}/retry`),
  stats: (projectId: string, params: { hours?: number; jobId?: string; queue?: string } = {}) => api.get<ProjectStats>(`/projects/${projectId}/stats`, { ...params }),
  timeseries: (projectId: string, params: { hours?: number; bucket?: 'hour' | 'day'; jobId?: string; queue?: string; mode?: ExecutionMode } = {}) =>
    api.get<Timeseries>(`/projects/${projectId}/stats/timeseries`, { ...params }),
};
