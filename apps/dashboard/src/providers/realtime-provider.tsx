'use client';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { UNAUTHORIZED_EVENT, eventStreamUrl } from '@/lib/api/client';
import { EXECUTION_STATUS } from '@/lib/status';
import { useNotifications } from '@/stores/notifications';
import type { Agent, ExecutionEvent, Worker } from '@/types/api';

/**
 * Dashboard real-time channel: Server-Sent Events from GET /v1/projects/:id/events (see
 * docs/WEBSOCKET_PROTOCOL.md, "Dashboard real-time protocol"). This is NOT the agent
 * WebSocket. Events are change notifications: they patch or invalidate TanStack Query
 * caches; the REST API stays the source of truth. Missed events are not replayed, so a
 * reconnect refetches everything for the project.
 */
export type RealtimeStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'unavailable';

interface RealtimeContextValue {
  status: RealtimeStatus;
  /** Poll interval pages should use while live updates are unavailable (false when live). */
  fallbackInterval: number | false;
}

const RealtimeContext = createContext<RealtimeContextValue>({ status: 'idle', fallbackInterval: 15_000 });

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}

const FALLBACK_POLL_MS = 15_000;

export function applyExecutionEvent(client: QueryClient, projectId: string, event: ExecutionEvent): void {
  client.setQueryData(['execution', projectId, event.id], (previous: unknown) => (previous && typeof previous === 'object' ? { ...previous, ...event } : previous));
}

export function RealtimeProvider({ projectId, children }: { projectId: string | null; children: React.ReactNode }) {
  const client = useQueryClient();
  const push = useNotifications((state) => state.push);
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const seen = useRef(new Map<string, string>());
  const pending = useRef(new Set<string>());

  useEffect(() => {
    if (!projectId || typeof EventSource === 'undefined') {
      setStatus(projectId ? 'unavailable' : 'idle');
      return;
    }
    let source: EventSource | null = null;
    let disposed = false;
    let wasOpen = false;
    seen.current.clear();

    // Coalesce invalidations: many events in a burst cause one refetch per query family.
    const flush = setInterval(() => {
      if (pending.current.size === 0) return;
      for (const family of pending.current) void client.invalidateQueries({ queryKey: [family, projectId] });
      if (pending.current.has('workers')) void client.invalidateQueries({ queryKey: ['workers'] });
      pending.current.clear();
    }, 1000);
    const touch = (...families: string[]) => families.forEach((family) => pending.current.add(family));

    const connect = () => {
      setStatus(wasOpen ? 'reconnecting' : 'connecting');
      source = new EventSource(eventStreamUrl(projectId));
      source.addEventListener('ready', () => {
        if (wasOpen) touch('executions', 'execution', 'jobs', 'job', 'queues', 'queue', 'stats', 'timeseries', 'agents', 'workers');
        wasOpen = true;
        setStatus('live');
      });
      source.addEventListener('execution.updated', (message) => {
        const event = JSON.parse((message as MessageEvent<string>).data) as ExecutionEvent;
        const fingerprint = `${event.status}:${event.attemptCount}`;
        if (seen.current.get(event.id) === fingerprint) return; // duplicate delivery
        seen.current.set(event.id, fingerprint);
        if (seen.current.size > 5000) seen.current.delete(seen.current.keys().next().value!);
        applyExecutionEvent(client, projectId, event);
        touch('executions', 'execution', 'execution-logs', 'jobs', 'job', 'queues', 'queue', 'stats', 'timeseries');
        if (event.status === 'FAILED' || event.status === 'DEAD_LETTERED') {
          push({
            id: `exec:${event.id}:${event.status}`,
            tone: 'danger',
            title: `${event.jobName}: ${EXECUTION_STATUS[event.status].label.toLowerCase()}`,
            ...(event.lastError ? { description: event.lastError.slice(0, 160) } : {}),
            href: `/executions/${event.id}`,
          });
        }
      });
      source.addEventListener('agent.updated', (message) => {
        const agent = JSON.parse((message as MessageEvent<string>).data) as Agent & { status: string };
        touch('agents', 'agent');
        if (agent.status === 'OFFLINE') {
          push({ id: `agent:${agent.id}:${Date.now()}`, tone: 'warning', title: `Agent disconnected: ${agent.hostname ?? agent.instanceId ?? agent.id}`, href: `/agents/${agent.id}` });
        }
      });
      source.addEventListener('worker.updated', (message) => {
        const worker = JSON.parse((message as MessageEvent<string>).data) as Worker;
        touch('workers', 'worker');
        if (worker.status === 'OFFLINE') {
          push({ id: `worker:${worker.id}:${Date.now()}`, tone: 'warning', title: `Worker offline: ${worker.hostname ?? worker.instanceId}`, href: `/workers/${worker.id}` });
        }
      });
      source.addEventListener('close', (message) => {
        const reason = (JSON.parse((message as MessageEvent<string>).data) as { reason?: string }).reason;
        source?.close();
        if (reason === 'unauthorized') {
          setStatus('unavailable');
          window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
        } else if (!disposed) {
          setTimeout(connect, 3000);
        }
      });
      source.onerror = () => {
        if (disposed || !source) return;
        // CONNECTING: the browser retries by itself. CLOSED: the server refused (HTTP error).
        if (source.readyState === EventSource.CLOSED) {
          setStatus('unavailable');
          setTimeout(() => !disposed && connect(), 30_000);
        } else {
          setStatus('reconnecting');
        }
      };
    };
    connect();

    return () => {
      disposed = true;
      clearInterval(flush);
      source?.close();
    };
  }, [projectId, client, push]);

  const value = useMemo<RealtimeContextValue>(() => ({ status, fallbackInterval: status === 'live' ? false : FALLBACK_POLL_MS }), [status]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
