import { api } from '@/lib/api/client';
import type { Agent, AgentDetail, ExecutorStatus } from '@/types/api';

export const agentsService = {
  list: (projectId: string, status?: ExecutorStatus) => api.get<Agent[]>(`/projects/${projectId}/agents`, { status }),
  get: (projectId: string, agentId: string) => api.get<AgentDetail>(`/projects/${projectId}/agents/${agentId}`),
  remove: (projectId: string, agentId: string) => api.delete(`/projects/${projectId}/agents/${agentId}`),
};
