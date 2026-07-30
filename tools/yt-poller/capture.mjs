// Captures raw JSON for unrecognized youtube-chat renderer types (see the
// patch in patches/) so new YT money formats — Jewels and whatever comes
// after — get harvested as real fixtures instead of silently vanishing.
import fs from 'node:fs';
import path from 'node:path';

export const CAPTURE_DIR = '/app/capture';
export const CAPTURE_FILE = 'unknown-renderers.jsonl';
export const CAPTURE_MAX_BYTES = 5 * 1024 * 1024;

export function bumpCount(counts, type) {
  counts[type] = (counts[type] || 0) + 1;
  return counts;
}

// Appends one raw JSON line. Rotates the file to `.1` (overwriting any prior
// rotation) once appending the next line would push it past maxBytes, so
// this stays bounded indefinitely rather than growing forever — a single
// generation of history is enough for fixture harvesting.
export function appendCapture(filePath, raw, maxBytes = CAPTURE_MAX_BYTES) {
  const line = JSON.stringify(raw) + '\n';
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    // file doesn't exist yet — starts at 0
  }
  if (size + Buffer.byteLength(line) > maxBytes) {
    try {
      fs.renameSync(filePath, filePath + '.1');
    } catch {
      // nothing to rotate yet
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line);
}
