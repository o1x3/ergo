// Map over items with bounded concurrency, preserving result order. Shared by
// the review engine (model batches) and the static-analysis runner (tools).
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  // Always run at least one worker; a misconfigured concurrency <= 0 must not
  // silently process zero items.
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}
