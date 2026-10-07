// Serialize short Web Lock operations in this tab. A recording holds its Web Lock
// beyond this queue; its acquisition operation ends when the lock callback starts.
export function createLocalLockQueue() {
  let tail = Promise.resolve();
  return {
    run(operation) {
      const result = tail.then(operation);
      tail = result.then(() => {}, () => {});
      return result;
    },
  };
}
