/**
 * Serialize short authority-bearing SQLite write sections inside one process.
 *
 * Turso/libSQL remains the cross-instance source of truth (all writes still use
 * conditional SQL/write transactions). This queue prevents the local libsql
 * driver from interleaving a base-client statement with an interactive
 * transaction on its single file-database connection during tests/dev.
 */
let securityWriteTail: Promise<void> = Promise.resolve();

export async function withSecurityWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = securityWriteTail;
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  securityWriteTail = previous.then(() => turn);
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
