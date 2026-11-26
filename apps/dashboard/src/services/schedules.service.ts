import { api } from '@/lib/api/client';
import type { ScheduleDefinitionInput, SchedulePreview, Upcoming } from '@/types/api';

export const schedulesService = {
  /** Authoritative occurrences of a saved job schedule. */
  jobPreview: (projectId: string, jobId: string, count = 10) =>
    api.get<{ timezone?: string; occurrences: string[] }>(`/projects/${projectId}/jobs/${jobId}/schedule/preview`, { count }),
  /** Validates an unsaved definition and returns its next occurrences (nothing is saved). */
  preview: (projectId: string, schedule: ScheduleDefinitionInput, count = 5) => api.post<SchedulePreview>(`/projects/${projectId}/schedule/preview`, { schedule, count }),
  upcoming: (projectId: string, range: { from?: string; to: string; jobId?: string }) => api.get<Upcoming>(`/projects/${projectId}/schedule/upcoming`, { ...range }),
};
