/**
 * @fileoverview Two runSuite calls, as a head and a base of one pair, each
 * read back their own metrics, and nothing lands in core/out/.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vite-plus/test';

import { runSuite } from '../../method/suite.ts';

const PROBE = 'tests/lab/verify/method/probe/probe.test.ts';
const CORE_OUT_PROBE = fileURLToPath(
  new URL('../../../../out/performance/probe.json', import.meta.url),
);
const RUN_TIMEOUT_MS = 120_000;

test(
  'a head run and a base run in one TMPDIR read back only their own metrics',
  async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'verify-method-'));
    try {
      const nonces = [101, 202];
      const read: number[] = [];
      for (const nonce of nonces) {
        process.env['PROBE_NONCE'] = String(nonce);
        const run = await runSuite({ tests: [PROBE], vitestArgs: [], tmpDir });
        expect(run.metrics).toHaveLength(1);
        read.push(run.metrics[0]!.value);
      }
      expect(read).toEqual(nonces);
      expect(existsSync(CORE_OUT_PROBE)).toBe(false);
    } finally {
      delete process.env['PROBE_NONCE'];
      rmSync(tmpDir, { recursive: true, force: true });
    }
  },
  RUN_TIMEOUT_MS,
);
