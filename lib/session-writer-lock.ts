/** Serialize file ownership changes, including the first await before a spawn. */
declare global {
  // Survives Next hot reload. Rejections never poison the next acquisition.
  var __piSessionWriterLocks: Map<string, Promise<void>> | undefined;
}

export async function withSessionWriterLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  const locks = globalThis.__piSessionWriterLocks ??= new Map();
  const previous = locks.get(id);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  locks.set(id, held); // Before any await: no start can pass an in-flight mutation.
  try {
    await previous;
    return await action();
  } finally {
    if (locks.get(id) === held) locks.delete(id);
    release();
  }
}
