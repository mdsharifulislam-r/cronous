/**
 * Reconnect delay with "full jitter": uniform in [0, min(max, initial * 2^attempt)].
 * Full jitter spreads reconnects after a server restart so thousands of agents do not
 * reconnect in lockstep.
 */
export function reconnectDelay(attempt: number, initialMs: number, maxMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, initialMs * 2 ** Math.min(attempt, 20));
  return Math.floor(random() * ceiling);
}

/** Converts the configured server URL into the agent WebSocket URL. */
export function agentSocketUrl(server: string, path: string): string {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new Error(`Invalid Chronos server URL "${server}"`);
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error(`Unsupported Chronos server URL scheme "${url.protocol}"`);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}
