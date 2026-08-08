import { vi } from 'vitest';

// Runs `fn` under vi.useFakeTimers(), guaranteeing vi.useRealTimers() even if
// fn throws — a bare vi.useFakeTimers() without this would leak fake timers
// into every test that runs after a failing one.
export async function withFakeTimers(fn) {
  vi.useFakeTimers();
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}
