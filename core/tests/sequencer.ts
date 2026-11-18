/**
 * @fileoverview The order core's test files start in: slowest first, whichever
 * project they are in.
 *
 * Vitest's own sequencer sorts by project name before duration, so with the
 * core and lab projects every core file started before the lab's slowest, a
 * 57 s file, and the suite ended 12 s after it instead of with it.
 */

import { relative } from 'node:path';

import { BaseSequencer, type TestSpecification } from 'vite-plus/test/node';

/** A file that has never run sorts before every file that has. */
const NEVER_RUN_MS = Number.POSITIVE_INFINITY;

export class SlowestFirst extends BaseSequencer {
  override async sort(
    files: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    return sorted.sort((a, b) => this.lastMs(b) - this.lastMs(a));
  }

  /** How long a file took last time, from vitest's results cache. */
  private lastMs(spec: TestSpecification): number {
    const key = `${spec.project.name}:${relative(this.ctx.config.root, spec.moduleId)}`;
    return this.ctx.cache.getFileTestResults(key)?.duration ?? NEVER_RUN_MS;
  }
}
