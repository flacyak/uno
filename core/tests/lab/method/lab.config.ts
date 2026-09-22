/**
 * @fileoverview core/vite.config.ts with one plugin added: every import that
 * resolves to tests/efficiency/record.ts, by alias or by relative path, is
 * handed ./record.ts instead, which writes metrics under METHOD_OUT_DIR.
 * Nothing else about the run changes: same setup file, same alias map, same
 * pool and worker count.
 *
 *   vp test --config tests/lab/method/lab.config.ts tests/performance
 */

import { fileURLToPath } from 'node:url';

import { mergeConfig } from 'vite-plus';
import type { Plugin } from 'vite-plus';

import core from '../../../vite.config.ts';

const RECORD = fileURLToPath(
  new URL('../../efficiency/record.ts', import.meta.url),
);
const STAND_IN = fileURLToPath(new URL('./record.ts', import.meta.url));

/** The id without any query Vite appended. */
function bare(id: string): string {
  const query = id.indexOf('?');
  return query === -1 ? id : id.slice(0, query);
}

function redirectRecord(): Plugin {
  return {
    name: 'method:redirect-record',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      // The stand-in itself imports the real record.ts.
      if (importer !== undefined && bare(importer) === STAND_IN) return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      return resolved !== null && bare(resolved.id) === RECORD
        ? STAND_IN
        : null;
    },
  };
}

export default mergeConfig(core, { plugins: [redirectRecord()] });
