/**
 * @fileoverview A find to the end of a sales file in a fresh process, where
 * readAll has read nothing but sales rows, with no session run first, so
 * every block but the opening sample is a miss. For the parent to run alone
 * and compare with the lab's finds, which ran after the lab had decoded the
 * synthetic and wide shapes in the same process.
 *
 * Usage, from core/:
 *   node --experimental-transform-types --import ../paths.js \
 *     tests/lab/verify/cache/find.ts <sales.csv> [finds]
 */

import { TUNING } from '@engine';
import { diskProvider } from '@store/node';
import { connect, indexed, openOne } from '@core-tests/engine/harness';
import { findToEnd } from '../../cache/session.ts';
import { Watch } from '../../cache/watch.ts';

const MB = 1 << 20;
const GB = 1 << 30;
const DEFAULT_FINDS = 3;

const [path, count] = process.argv.slice(2);
if (path === undefined) throw new Error('usage: find.ts <sales.csv> [finds]');
const finds = count === undefined ? DEFAULT_FINDS : Number(count);
const watch = new Watch(diskProvider());
const { engine, done } = connect(TUNING, [watch.provider]);
try {
  const src = await openOne(engine, { name: 'sales.csv', path });
  await indexed(src);
  const size = watch.bytes;
  const runs = [];
  for (let i = 0; i < finds; i++) {
    const r = await findToEnd(src, watch);
    if (!r.found.complete || r.found.row !== null) throw new Error('find stopped early');
    runs.push({
      ms: Math.round(r.ms),
      readMB: Number((r.bytes / MB).toFixed(1)),
      msPerGBRead: Math.round((r.ms * GB) / r.bytes),
    });
  }
  process.stdout.write(`${JSON.stringify({ indexedMB: Number((size / MB).toFixed(1)), runs })}\n`);
} finally {
  done();
}
