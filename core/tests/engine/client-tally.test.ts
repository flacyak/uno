/**
 * @fileoverview A source handle hears its charts' tallies over a fake port:
 * each taken at its generation or later, and none moves the generation. An
 * older engine's open, which names no charts, reads as an open of none.
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
/** What an engine from before cells and charts answers an open with. */
const OLDER: Opening = { opened: [OPENED], showing: OPENED.source };
const ADDED: Opening = {
  ...OLDER,
  cells: [],
  charts: [],
  carriedIds: [],
  carriedOver: [],
};

/** told is the reply telling CHART's tally over `source` at `generation`. */
function told(generation: number, source = OPENED.source): Reply {
  return { t: 'tally', source, chart: CHART, generation, tally: GONE };
}

/** answering returns an engine answered by a fake that gives `added` to an
 * open, and the way to send it any other reply. */
function answering(added: Opening) {
  let receive: (msg: Reply) => void = () => {};
  const port: Port<Reply, Request> = {
    post: (msg) => {
      if (msg.t === 'open') receive({ t: 'opened', id: msg.id, added });
    },
    listen: (fn) => {
      receive = fn;
    },
    close: () => {},
  };
  return { engine: new Engine(port), send: (msg: Reply) => receive(msg) };
}

/** hears returns what a handle on OPENED heard of `sent`, and its generation. */
async function hears(sent: Reply[]) {
  const { engine, send } = answering(ADDED);
  const [handle] = (await engine.open({ name: NAME, path: NAME })).sources;
  const heard: Array<[string, Tally]> = [];
  handle!.onTally = (chart, tally) => heard.push([chart, tally]);
  for (const msg of sent) send(msg);
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

test('an open by an engine from before charts names no cells and no charts', async () => {
  const added = await answering(OLDER).engine.open({ name: NAME, path: NAME });
  expect(added).toMatchObject({
    cells: [],
    charts: [],
    carriedIds: [],
    carriedOver: [],
  });
});
