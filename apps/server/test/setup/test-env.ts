export const TEST_DATABASE_URL =
  process.env.CHRONOS_TEST_DATABASE_URL ?? 'postgresql://chronos:chronos@127.0.0.1:55432/chronos_test';
export const TEST_REDIS_URL = process.env.CHRONOS_TEST_REDIS_URL ?? 'redis://127.0.0.1:56379/0';
export const TEST_NAMESPACE = 'chronos_test';
export const TEST_BOOTSTRAP_TOKEN = 'test-bootstrap-token-0123456789abcdef0123456789';
