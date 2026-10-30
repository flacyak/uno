/**
 * @fileoverview An engine whose far end a test scripts: it opens one source
 * whatever it is asked to open, and answers a rows request with the replies
 * the test hands it and then an empty page. A test of what a client does
 * with a reply reads it here, with no source behind it.
 */

import { Engine, messagePort } from '@engine';
import type {
  ColumnInfo,
  MessagePortLike,
  Opened,
  Reply,
  Request,
} from '@engine';

/** The source a scripted engine opens. */
export const SCRIPTED_SOURCE = 'events';

/** columnsOf returns text columns with these headers. */
export function columnsOf(...headers: string[]): ColumnInfo[] {
  return headers.map((header) => ({ header, kind: 'text', flagged: false }));
}

/** openedWith returns what a scripted engine says it opened. */
function openedWith(columns: ColumnInfo[]): Opened {
  return {
    source: SCRIPTED_SOURCE,
    name: 'events.jsonl',
    size: 0,
    columns,
    progress: {
      done: 0,
      total: 0,
      readable: 0,
      rows: 0,
      complete: false,
      elapsedMs: 0,
    },
    edits: [],
    generation: 0,
  };
}

/**
 * scriptedEngine answers an open with one source, and a rows request with
 * `before` and then an empty page, so every reply in `before` has arrived
 * by the time the rows do.
 */
export function scriptedEngine(before: readonly Reply[]): Engine {
  const { port1, port2 } = new MessageChannel();
  const far = messagePort<Request, Reply>(port1 as unknown as MessagePortLike);
  far.listen((request) => {
    if (request.t === 'open') {
      const opened = openedWith(columnsOf('id'));
      far.post({
        t: 'opened',
        id: request.id,
        added: { opened: [opened], showing: SCRIPTED_SOURCE },
      });
    } else if (request.t === 'rows') {
      for (const reply of before) far.post(reply);
      far.post({
        t: 'rows',
        id: request.id,
        first: 0,
        generation: 0,
        rows: [],
        raws: [],
      });
    }
  });
  return new Engine(
    messagePort<Reply, Request>(port2 as unknown as MessagePortLike),
  );
}
