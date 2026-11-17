// Runs once before the test suite: build the app so tests never run against a
// stale dist/, and generate fixtures if they're missing.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export default function globalSetup() {
  execFileSync(process.execPath, [join(ROOT, 'build.mjs')], { stdio: 'inherit' });
  if (!existsSync(join(ROOT, 'tests/fixtures/manifest.json'))) {
    execFileSync(process.execPath, [join(ROOT, 'tests/make-fixtures.mjs')], { stdio: 'inherit' });
  }
}
