/** Polls `probe` until it returns a truthy value or the timeout elapses. */
export async function waitFor<T>(probe: () => Promise<T> | T, options: { timeoutMs?: number; intervalMs?: number; message?: string } = {}): Promise<NonNullable<T>> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 50));
  }
  throw new Error(`Timed out waiting for ${options.message ?? 'condition'} (last value: ${JSON.stringify(last)})`);
}
