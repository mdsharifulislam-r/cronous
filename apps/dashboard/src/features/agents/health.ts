import type { Agent, Worker } from '@/types/api';
import type { StatusView } from '@/lib/status';

/**
 * Executor health from what the API records (status + last heartbeat). An executor still
 * marked online whose heartbeats stopped is "Unhealthy": the reaper marks it offline
 * after a few missed intervals.
 */
export function agentHealth(agent: Pick<Agent, 'status' | 'lastHeartbeatAt'>, heartbeatMs: number, now = Date.now()): StatusView {
  if (agent.status === 'OFFLINE') return { label: 'Disconnected', tone: 'neutral', description: 'Not connected' };
  if (agent.status === 'DRAINING') return { label: 'Draining', tone: 'warning', description: 'Shutting down: finishing work, taking no new work' };
  const silence = now - new Date(agent.lastHeartbeatAt).getTime();
  if (silence > heartbeatMs * 3) return { label: 'Unhealthy', tone: 'danger', description: `No heartbeat for ${Math.round(silence / 1000)}s` };
  return { label: 'Connected', tone: 'success', description: 'Heartbeating normally' };
}

export function workerHealth(worker: Pick<Worker, 'status' | 'lastHeartbeatAt' | 'concurrency' | 'runningExecutions'>, now = Date.now()): StatusView {
  if (worker.status === 'OFFLINE') return { label: 'Offline', tone: 'neutral', description: 'Stopped or lost' };
  if (worker.status === 'DRAINING') return { label: 'Draining', tone: 'warning', description: 'Shutting down' };
  const silence = now - new Date(worker.lastHeartbeatAt).getTime();
  if (silence > 45_000) return { label: 'Unhealthy', tone: 'danger', description: `No heartbeat for ${Math.round(silence / 1000)}s` };
  if ((worker.runningExecutions ?? 0) >= worker.concurrency) return { label: 'Busy', tone: 'info', description: 'All concurrency slots in use' };
  return { label: 'Online', tone: 'success', description: 'Heartbeating, has free capacity' };
}
