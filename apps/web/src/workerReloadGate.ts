/**
 * A reload the service worker asks for waits while work a reload would cut short is running, such
 * as turning on notifications or an open file picker. It runs once the last hold is released.
 */
export function createWorkerReloadGate(reload: () => void) {
  let holds = 0;
  let requested = false;
  return {
    hold(): () => void {
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        if (holds === 0 && requested) reload();
      };
    },
    request(): void {
      requested = true;
      if (holds === 0) reload();
    },
  };
}
