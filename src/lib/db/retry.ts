/**
 * Turso's HTTP endpoint occasionally resets an idle keep-alive socket. Reads are
 * idempotent, so retry a failed read once before surfacing the error.
 */
export async function retryRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    console.error("DB read failed; retrying once:", error instanceof Error ? error.message : error);
    return read();
  }
}
