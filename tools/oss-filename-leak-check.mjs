#!/usr/bin/env node
// Content-scan gate for publish-oss.sh: catches source-code comments that
// reference an excluded internal doc BY FILENAME (e.g. "see
// SHIP_REPORT_2026-08-09_combo.md"). .oss-exclude keeps the doc itself out
// of the publish, but a comment naming it by filename still leaks its
// existence/date into published code — confirmed live 2026-08-18: 3 hits
// landed via a merged PR before this gate existed, 2 more found once the
// pattern set was widened to include *_REVIEW_*.md.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Derive content-scan substrings from .oss-exclude's own wildcard filename
// globs (e.g. "*_AUDIT_*.md" -> "_AUDIT_", "SHIP_REPORT_*.md" -> "SHIP_REPORT_")
// — a comment mentioning any of these tokens is naming an excluded doc by
// its naming convention, regardless of the specific date/suffix. Exact
// (non-wildcard) filenames in .oss-exclude are already covered by their
// shared convention token, so only wildcard lines are used as the source.
export function derivePatterns(ossExcludeContent) {
  const patterns = new Set();
  for (const rawLine of ossExcludeContent.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('*')) continue;
    const stripped = line.replace(/\*/g, '').replace(/\.md$/, '');
    if (stripped.length >= 4) patterns.add(stripped);
  }
  return [...patterns];
}

export function scanDirForPatterns(dir, patterns, { excludeDirs = ['.git', 'node_modules'], excludeFiles = [] } = {}) {
  const hits = [];
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (excludeDirs.includes(entry.name)) continue;
        walk(path.join(d, entry.name));
      } else if (entry.isFile()) {
        if (excludeFiles.includes(entry.name)) continue;
        let content;
        try {
          content = readFileSync(path.join(d, entry.name), 'utf8');
        } catch {
          continue; // binary or unreadable — not a text leak vector
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          for (const p of patterns) {
            if (lines[i].includes(p)) {
              hits.push({ file: path.join(d, entry.name), line: i + 1, pattern: p, text: lines[i].trim() });
            }
          }
        }
      }
    }
  }
  walk(dir);
  return hits;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const scanRoot = process.argv[2];
  if (!scanRoot) {
    console.error('usage: node oss-filename-leak-check.mjs <dir-to-scan>');
    process.exit(2);
  }
  const root = path.dirname(fileURLToPath(import.meta.url));
  const ossExcludePath = process.env.OSS_EXCLUDE_FILE
    ? path.resolve(process.env.OSS_EXCLUDE_FILE)
    : path.join(root, '..', '.oss-exclude');
  const patterns = derivePatterns(readFileSync(ossExcludePath, 'utf8'));
  const hits = scanDirForPatterns(scanRoot, patterns, {
    // These three necessarily contain the literal pattern strings as their
    // own subject matter (glob source, denylist definitions, unit-test
    // fixtures) — not real leaks of an excluded doc's existence.
    excludeFiles: ['.oss-exclude', 'publish-oss.sh', 'oss-filename-leak-check.mjs', 'oss-filename-leak-check.test.mjs'],
  });
  if (hits.length) {
    console.error(`abort: internal doc filenames referenced in staged export content (${hits.length} hit(s)):`);
    for (const h of hits) console.error(`  ${h.file}:${h.line}: ${h.text}`);
    process.exit(1);
  }
  console.log('oss-filename-leak-check: clean');
  process.exit(0);
}
