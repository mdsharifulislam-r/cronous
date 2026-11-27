import { Chronos } from '@cronous/cronous';

/**
 * One shared SDK instance for the whole application. Import it from any module to
 * register tasks. The agent token comes from CHRONOS_AGENT_TOKEN; the SDK never needs
 * Redis or database credentials.
 */
export const chronos = new Chronos({
  server: process.env.CHRONOS_SERVER!,
  project: process.env.CHRONOS_PROJECT ?? 'storefront',
  timezone: 'Asia/Dhaka',
});
