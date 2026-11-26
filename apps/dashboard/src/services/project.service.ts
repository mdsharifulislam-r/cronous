import { api } from '@/lib/api/client';
import type { Credential, IssuedCredential, Project, SystemInfo } from '@/types/api';

export const projectService = {
  list: (orgId: string) => api.get<Project[]>(`/organizations/${orgId}/projects`),
  get: (projectId: string) => api.get<Project>(`/projects/${projectId}`),
  create: (orgId: string, input: { name: string; slug: string; timezone: string }) => api.post<Project>(`/organizations/${orgId}/projects`, input),
  update: (projectId: string, input: { name?: string; timezone?: string }) => api.patch<Project>(`/projects/${projectId}`, input),
  archive: (projectId: string) => api.delete(`/projects/${projectId}`),
  credentials: (projectId: string, includeRevoked = false) => api.get<Credential[]>(`/projects/${projectId}/credentials`, { includeRevoked }),
  createCredential: (projectId: string, input: { kind: 'PROJECT' | 'AGENT'; name: string; expiresInDays?: number }) =>
    api.post<IssuedCredential>(`/projects/${projectId}/credentials`, input),
  rotateCredential: (projectId: string, credentialId: string, gracePeriodSeconds: number) =>
    api.post<{ credential: IssuedCredential; previous: Credential }>(`/projects/${projectId}/credentials/${credentialId}/rotate`, { gracePeriodSeconds }),
  revokeCredential: (projectId: string, credentialId: string) => api.delete<Credential>(`/projects/${projectId}/credentials/${credentialId}`),
  system: () => api.get<SystemInfo>('/system'),
};
