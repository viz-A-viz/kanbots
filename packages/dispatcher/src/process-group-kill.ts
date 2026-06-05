import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Kill a child process and its entire process group on POSIX.
 * On Windows, falls back to taskkill /T /F for SIGKILL, then direct child.kill().
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (IS_WINDOWS) {
    if (signal === 'SIGKILL' && typeof pid === 'number') {
      try {
        nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F']).on('error', () => {
          // Best-effort; fall through to direct kill.
        });
      } catch {
        // ignore — fall through to direct kill below
      }
    }
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
    return;
  }
  if (typeof pid === 'number') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // pgid kill failed — fall through to direct kill
    }
  }
  try {
    child.kill(signal);
  } catch {
    // ignore — child may already be gone
  }
}

/**
 * Wait for a child process to exit, with a hard timeout that force-kills
 * the process group and then force-resolves if the child still doesn't die.
 *
 * @param child       The ChildProcess to wait on.
 * @param timeoutMs   How long to wait before sending SIGTERM.
 * @param opts        Optional settings: killTimeoutMs (default 5s), escalationMs (default 10s), onTimeout callback.
 * @returns Exit code, or 137 if force-killed, or 0 if force-resolved after kill timeout.
 */
export async function waitForChildWithTimeout(
  child: ChildProcess,
  timeoutMs: number,
  opts?: { killTimeoutMs?: number; escalationMs?: number; onTimeout?: () => void },
): Promise<number> {
  const killTimeoutMs = opts?.killTimeoutMs ?? 5_000;
  const escalationMs = opts?.escalationMs ?? 10_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      opts?.onTimeout?.();
      killProcessGroup(child, 'SIGTERM');
      // Escalation to SIGKILL after grace period
      killTimer = setTimeout(() => {
        if (settled) return;
        killProcessGroup(child, 'SIGKILL');
        // Hard timeout: if SIGKILL doesn't work, force-resolve so we don't hang forever
        killTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(137);
        }, killTimeoutMs);
        killTimer.unref?.();
      }, escalationMs);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(timer);
      // When the child is killed by a signal, code is null. Return the
      // conventional 128 + signal number so callers can detect termination.
      if (code === null && signal) {
        const signalToCode: Record<string, number> = {
          SIGTERM: 143,
          SIGKILL: 137,
          SIGINT: 130,
        };
        resolve(signalToCode[signal] ?? 1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}
