'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { hasRole } from '@/lib/permissions';
import { qk } from '@/lib/query-keys';
import { authService, projectService } from '@/services';
import { useWorkspaceStore } from '@/stores/workspace';
import type { OrgRole } from '@/types/api';

/**
 * The signed-in user, the selected organization and project, and the user's role there.
 * Selections come from the store but are validated against what the API returns, so a
 * stale selection (removed membership, archived project) silently falls back.
 */
export function useWorkspace() {
  const { orgId: storedOrg, projectId: storedProject, setOrg, setProject } = useWorkspaceStore();
  const me = useQuery({ queryKey: qk.me, queryFn: authService.me, staleTime: 60_000 });

  const organizations = useMemo(() => me.data?.organizations ?? [], [me.data]);
  const organization = organizations.find((org) => org.id === storedOrg) ?? organizations[0];

  const projects = useQuery({
    queryKey: qk.projects(organization?.id ?? 'none'),
    queryFn: () => projectService.list(organization!.id),
    enabled: Boolean(organization),
    staleTime: 60_000,
  });
  const project = projects.data?.find((item) => item.id === storedProject) ?? projects.data?.[0];

  useEffect(() => {
    if (organization && organization.id !== storedOrg) setOrg(organization.id);
  }, [organization, storedOrg, setOrg]);
  useEffect(() => {
    if (project && project.id !== storedProject) setProject(project.id);
  }, [project, storedProject, setProject]);

  const role = organization?.role;
  return useMemo(
    () => ({
      me: me.data,
      isLoading: me.isLoading || (Boolean(organization) && projects.isLoading),
      error: me.error ?? projects.error,
      organizations,
      organization,
      projects: projects.data ?? [],
      project,
      role,
      can: (required: OrgRole) => hasRole(role, required),
    }),
    [me.data, me.isLoading, me.error, organizations, organization, projects.data, projects.isLoading, projects.error, project, role],
  );
}

/** For pages that need a project: throws-free accessor with the id or null. */
export function useProjectId(): string | null {
  return useWorkspace().project?.id ?? null;
}
