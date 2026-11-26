import { api } from '@/lib/api/client';
import type { AuditEntry, Page } from '@/types/api';

export interface ActivityFilters {
  projectId?: string;
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export const activityService = {
  list: (orgId: string, filters: ActivityFilters = {}) => api.get<Page<AuditEntry>>(`/organizations/${orgId}/audit-logs`, { ...filters }),
};
