/**
 * @fileoverview The worker_threads entry of a ScanPool: scans each chunk it
 * is sent and transfers the begins back.
 *
 * It loads only speculate.ts, which has no TypeScript-only runtime syntax,
 * so Node runs it with its default type stripping and no flags.
 */

import { parentPort } from 'node:worker_threads';

import type { Job, Reply } from './messages.ts';
import { scanChunk } from './speculate.ts';

const port = parentPort;
if (port === null) throw new Error('worker.ts runs as a worker thread');

/** cpuMicros is this thread's CPU time so far, user and system together. */
function cpuMicros(): number {
  const { user, system } = process.threadCpuUsage();
  return user + system;
}

port.on('message', (job: Job) => {
  let reply: Reply;
  try {
    const scan = scanChunk(job.bytes, job.base, job.sep);
    reply = { kind: 'done', id: job.id, scan, cpuMicros: cpuMicros() };
    port.postMessage(reply, [scan.begins.buffer]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply = { kind: 'failed', id: job.id, message, cpuMicros: cpuMicros() };
    port.postMessage(reply);
  }
});

const ready: Reply = { kind: 'ready', cpuMicros: cpuMicros() };
port.postMessage(ready);
