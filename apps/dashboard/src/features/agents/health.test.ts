import { describe, expect, it } from 'vitest';
import { agentHealth, workerHealth } from './health';

const now = Date.parse('2026-01-01T00:01:00Z');

describe('executor health', () => {
  it('flags online agents that stopped heartbeating', () => {
    expect(agentHealth({ status: 'ONLINE', lastHeartbeatAt: '2026-01-01T00:00:55Z' }, 10_000, now).label).toBe('Connected');
    expect(agentHealth({ status: 'ONLINE', lastHeartbeatAt: '2026-01-01T00:00:00Z' }, 10_000, now)).toMatchObject({ label: 'Unhealthy', tone: 'danger' });
    expect(agentHealth({ status: 'DRAINING', lastHeartbeatAt: '2026-01-01T00:00:55Z' }, 10_000, now).label).toBe('Draining');
    expect(agentHealth({ status: 'OFFLINE', lastHeartbeatAt: '2026-01-01T00:00:00Z' }, 10_000, now).label).toBe('Disconnected');
  });

  it('marks full workers busy and silent ones unhealthy', () => {
    const fresh = '2026-01-01T00:00:50Z';
    expect(workerHealth({ status: 'ONLINE', lastHeartbeatAt: fresh, concurrency: 2, runningExecutions: 1 }, now).label).toBe('Online');
    expect(workerHealth({ status: 'ONLINE', lastHeartbeatAt: fresh, concurrency: 2, runningExecutions: 2 }, now).label).toBe('Busy');
    expect(workerHealth({ status: 'ONLINE', lastHeartbeatAt: '2026-01-01T00:00:00Z', concurrency: 2, runningExecutions: 0 }, now).label).toBe('Unhealthy');
    expect(workerHealth({ status: 'OFFLINE', lastHeartbeatAt: fresh, concurrency: 2 }, now).label).toBe('Offline');
  });
});
