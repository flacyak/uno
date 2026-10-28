/**
 * @fileoverview A source handle hears its charts' tallies over a fake port:
 * each taken at its generation or later, and none moves the generation.
 */

import { expect, test } from 'vite-plus/test';

import { Engine } from '@engine';
import type { Opened, Opening, Port, Reply, Request, Tally } from '@engine';

const NAME = 'sales.csv';
const CHART = 'c1';
const GONE: Tally = { t: 'unread', said: { t: 'source-absent', name: NAME } };
/** The one source the fake engine opens, at the log's first generation. */
const OPENED: Opened = {
  source: 'sales',
  name: NAME,
  size: 0,
  columns: [],
  progress: {
    done: 0,
    total: 0,
    readable: 0,
    rows: 0,
    complete: true,
    elapsedMs: 0,
  },
  edits: [],
  generation: 0,
};
const ADDED: Opening = {
  opened: [OPENED],
  showing: OPENED.source,
  cells: [],
  charts: [],
  carriedIds: [],
};

/** told is the reply telling CHART's tally over `source` at `generation`. */
function told(generation: number, source = OPENED.source): Reply {
  return { t: 'tally', source, chart: CHART, generation, tally: GONE };
}

/** hears returns what a handle on OPENED heard of `sent`, and its generation. */
async function hears(sent: Reply[]) {
  let receive: (msg: Reply) => void = () => {};
  const port: Port<Reply, Request> = {
    post: (msg) => {
      if (msg.t === 'open') receive({ t: 'opened', id: msg.id, added: ADDED });
    },
    listen: (fn) => {
      receive = fn;
    },
    close: () => {},
  };
  const engine = new Engine(port);
  const [handle] = (await engine.open({ name: NAME, path: NAME })).sources;
  const heard: Array<[string, Tally]> = [];
  handle!.onTally = (chart, tally) => heard.push([chart, tally]);
  for (const msg of sent) receive(msg);
  return { heard, generation: handle!.generation };
}

test("a tally taken at the handle's generation or later is heard, and leaves the generation as it is", async () => {
  const { generation } = OPENED;
  const sent = [told(generation), told(generation + 1)];
  const heard = sent.map(() => [CHART, GONE]);
  expect(await hears(sent)).toEqual({ heard, generation });
});

test("a tally taken before the handle's generation, or over a source the engine has not opened, is dropped", async () => {
  const { source, generation } = OPENED;
  const later = generation + 1;
  // The offer the engine sends after an edit moves the handle to `later`.
  const offer: Reply = { t: 'offer', source, generation: later, offer: null };
  const sent = [offer, told(generation), told(later, 'elsewhere')];
  expect((await hears(sent)).heard).toEqual([]);
});
