// Lets promise chains run to the end between a test's steps.

/** Waits `turns` turns of the microtask queue, enough for a short chain of awaits to settle. */
export async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}
