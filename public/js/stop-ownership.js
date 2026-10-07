// The Web Lock must outlive source cleanup, even when final segment persistence fails.
export async function stopRecorderUnderLock(rec, cleanup, release, lockTask) {
  try {
    await rec.stop();
    await cleanup();
  } finally {
    if (!rec.sourceCleanupFailed) {
      release?.();
      await lockTask;
    }
  }
}
