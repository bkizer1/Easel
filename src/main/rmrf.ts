/**
 * Robust recursive directory removal.
 *
 * On Windows a subprocess that has just exited — e.g. a `git` invocation run by
 * a test — can still hold a handle to a file under the directory when we try to
 * remove it, so a plain recursive remove throws EBUSY/EPERM. `rmSync`'s
 * maxRetries/retryDelay retry with a linear backoff, which clears the race once
 * the OS releases the handle. `force` ignores an already-absent directory.
 *
 * Used by the git-heavy test suites' teardown; safe anywhere a temp dir that a
 * child process touched needs to be torn down.
 */

import { rmSync } from 'node:fs';

export function rmrf(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
