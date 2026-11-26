/**
 * Start a process-bound sleep inhibitor without delaying remote-device startup.
 * The caller handles both synchronous errors and later Promise rejection.
 */
export function launchCaffeinateNonBlocking(
  start: (options: { pid: number }) => unknown,
  pid: number,
  onError: (error: unknown) => void,
): boolean {
  try {
    // Attaching catch before returning prevents an unhandled rejection.
    void Promise.resolve(start({ pid })).catch(onError);
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}
