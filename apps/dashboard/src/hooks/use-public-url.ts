'use client';
import { useQuery } from '@tanstack/react-query';

const FALLBACK = 'https://chronos.example.com';

/** Public Chronos API URL shown in SDK and curl snippets (`CHRONOS_PUBLIC_URL` on the dashboard). */
export function usePublicUrl(): string {
  const { data } = useQuery({
    queryKey: ['dashboard-config'],
    queryFn: async (): Promise<{ publicUrl: string | null }> => {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (!response.ok) return { publicUrl: null };
      return (await response.json()) as { publicUrl: string | null };
    },
    staleTime: Infinity,
    retry: false,
  });
  return data?.publicUrl || FALLBACK;
}
