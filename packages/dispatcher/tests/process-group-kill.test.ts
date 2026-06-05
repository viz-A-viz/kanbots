import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { killProcessGroup, waitForChildWithTimeout } from '../src/process-group-kill.js';

describe('process-group-kill', () => {
  it('killProcessGroup kills a shell and its child sleep', async () => {
    const child = spawn('sh', ['-c', 'sleep 1000'], { detached: true });
    // Give the shell a moment to start sleep
    await new Promise((r) => setTimeout(r, 100));

    // Verify sleep is running
    const before = await countSleepProcesses();
    expect(before).toBeGreaterThanOrEqual(1);

    killProcessGroup(child, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));

    const after = await countSleepProcesses();
    expect(after).toBe(0);
  });

  it('waitForChildWithTimeout sends SIGTERM then SIGKILL on timeout', async () => {
    const child = spawn('sh', ['-c', 'trap "" TERM; sleep 1000'], { detached: true });
    const start = Date.now();

    const exitCode = await waitForChildWithTimeout(child, 100, {
      escalationMs: 200,
      killTimeoutMs: 500,
    });

    const elapsed = Date.now() - start;
    // Should be killed by SIGKILL after ~300ms (100ms timeout + 200ms escalation)
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1000);
    expect(exitCode).toBe(137);

    // Ensure no orphaned sleep remains
    await new Promise((r) => setTimeout(r, 200));
    const after = await countSleepProcesses();
    expect(after).toBe(0);
  });

  it('waitForChildWithTimeout resolves normally when child exits quickly', async () => {
    const child = spawn('sh', ['-c', 'exit 42'], { detached: true });
    const exitCode = await waitForChildWithTimeout(child, 10_000);
    expect(exitCode).toBe(42);
  });
});

async function countSleepProcesses(): Promise<number> {
  try {
    const { execSync } = await import('node:child_process');
    const out = execSync('ps aux | grep "sleep 1000" | grep -v grep || true', { encoding: 'utf8' });
    return out.trim() === '' ? 0 : out.trim().split('\n').length;
  } catch {
    return 0;
  }
}
