import { api } from '@/lib/api/client';
import type { Member, OrgRole, Organization } from '@/types/api';

export const organizationService = {
  list: () => api.get<Organization[]>('/organizations'),
  get: (orgId: string) => api.get<Organization>(`/organizations/${orgId}`),
  create: (input: { name: string; slug: string }) => api.post<Organization>('/organizations', input),
  update: (orgId: string, input: { name: string }) => api.patch<Organization>(`/organizations/${orgId}`, input),
  remove: (orgId: string) => api.delete(`/organizations/${orgId}`),
  members: (orgId: string) => api.get<Member[]>(`/organizations/${orgId}/members`),
  addMember: (orgId: string, input: { email: string; role: OrgRole; name?: string; password?: string }) => api.post<Member>(`/organizations/${orgId}/members`, input),
  updateMember: (orgId: string, userId: string, role: OrgRole) => api.patch<Member>(`/organizations/${orgId}/members/${userId}`, { role }),
  removeMember: (orgId: string, userId: string) => api.delete(`/organizations/${orgId}/members/${userId}`),
};
