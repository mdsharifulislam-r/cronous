'use client';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * Genuinely global client state: which organization/project the user is looking at and
 * the sidebar preference. Persisted per browser (no secrets). Server data lives in
 * TanStack Query, not here.
 */
interface WorkspaceState {
  orgId: string | null;
  projectId: string | null;
  sidebarCollapsed: boolean;
  setOrg: (orgId: string) => void;
  setProject: (projectId: string) => void;
  toggleSidebar: () => void;
  reset: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      orgId: null,
      projectId: null,
      sidebarCollapsed: false,
      setOrg: (orgId) => set((state) => (state.orgId === orgId ? state : { orgId, projectId: null })),
      setProject: (projectId) => set({ projectId }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      reset: () => set({ orgId: null, projectId: null }),
    }),
    {
      name: 'chronos.workspace',
      storage: createJSONStorage(() => {
        try {
          return window.localStorage;
        } catch {
          return { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
        }
      }),
      partialize: (state) => ({ orgId: state.orgId, projectId: state.projectId, sidebarCollapsed: state.sidebarCollapsed }),
    },
  ),
);
