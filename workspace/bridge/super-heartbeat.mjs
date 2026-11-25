/** Slow status writes share one heartbeat rather than building a timer queue. */
export function createHeartbeat({ beat, publish, onError }) {
  let pending, stopped = false;
  return {
    tick() {
      if (stopped) return Promise.resolve();
      if (pending) return pending;
      pending = Promise.resolve().then(beat).then(publish).catch(onError).finally(() => { pending = undefined; });
      return pending;
    },
    async close() {
      stopped = true;
      await pending;
    },
  };
}
