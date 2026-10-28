/**
 * @fileoverview A session: the conversation between a page and an engine,
 * which outlives the socket it is on.
 *
 * Every frame is numbered and says the highest number heard from the other
 * side. Each side keeps what it has sent until the other says it arrived.
 * When the socket drops and another is attached, each side says what it has
 * heard and sends again what the other may not have, and a frame that
 * arrives twice is dropped by its number. So a drop costs the conversation
 * nothing: a request in flight is answered, a reply in flight arrives, and
 * neither side can tell the drop from a slow socket.
 *
 * What ends a session is its owner's to say: a socket closed on purpose, or
 * one gone for too long. The session reports a socket's close and its code,
 * and its owner attaches another or ends it.
 */

import { formatBytes, messageOf } from './protocol.ts';
import type { MessagePortLike, Reply } from './protocol.ts';
import { FRAME_LIMIT, decode, encode, frameBytes } from './wire.ts';
import type { Carried, Frame } from './wire.ts';

/**
 * How long a side waits for a frame of its own to carry its acknowledgement
 * before sending it alone. A page that has asked for nothing more still
 * tells the engine its replies arrived, so the engine keeps none of them.
 */
const ACK_DELAY_MS = 500;

/**
 * The close code of a socket closed on purpose, by either side. Any other
 * code is a socket lost, which the session may be resumed over another.
 */
export const CLOSED = 1000;

/**
 * The close code a server answers a resume with when there is no session
 * to resume: its engine is gone, and so is the session.
 */
export const GONE = 4410;

/** The part of a web socket a session uses. The `ws` package's has it too. */
export interface WebSocketLike {
  binaryType: string;
  send(data: string | Blob): void;
  close(code?: number): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  addEventListener(type: 'close', fn: (e: { code: number }) => void): void;
}

/** One frame kept until the far side says it arrived. */
interface Kept {
  seq: number;
  frame: Frame;
}

/** The event type and listener pairs a port accepts. */
type Listening =
  | ['message', (e: { data: unknown }) => void]
  | ['close', () => void];

/** trouble builds an unnumbered error reply for a frame that failed to decode. */
function trouble(text: string): Reply {
  return { t: 'error', said: { t: 'text', text } };
}

/** join turns a frame into the one value a socket sends. */
function join(frame: Frame): string | Blob {
  return typeof frame === 'string' ? frame : new Blob(frame);
}

export class Session {
  private readonly far: string;
  private readonly limit: number;

  /**
   * Called when the socket the session is on closes, with its code. Not
   * called for a socket replaced by `attach`, nor once the session is over.
   * The owner attaches another socket or ends the session; a session left
   * to itself ends.
   */
  onClose: (code: number) => void = () => this.end();

  /**
   * Called with the error reply for a frame that does not decode, which says
   * who sent it. Heard here unless the owner says otherwise: an engine
   * answers it to the page instead, since the page is who it is for.
   */
  onTrouble: (reply: Reply) => void = (reply) => this.deliver(reply);

  /** The session as the port a client or an engine speaks over. */
  readonly port: MessagePortLike;

  private socket: WebSocketLike | undefined;
  /** The number of the last frame sent, and the highest heard. */
  private sent = 0;
  private heard = 0;
  /** What was heard, as the far side was last told. */
  private told = 0;
  private readonly kept: Kept[] = [];
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners: Array<(e: { data: unknown }) => void> = [];
  private readonly closes: Array<() => void> = [];
  private over = false;

  /**
   * `far` names the other side in the sentence a frame it sent that does not
   * decode is reported with. `postMessage` throws if the encoded frame is
   * over `limit` bytes.
   */
  constructor(far: string, limit = FRAME_LIMIT) {
    this.far = far;
    this.limit = limit;
    this.port = {
      postMessage: (message) => this.send(message),
      addEventListener: (...[type, fn]: Listening) => {
        if (type === 'message') this.listeners.push(fn);
        else this.closes.push(fn);
      },
      // A web socket delivers from the moment it opens, so start returns at once.
      start: () => undefined,
      // A close from this side ends listening in silence, as a port's does.
      close: () => this.close(),
    };
  }

  /** Frames sent that the far side has not yet said arrived. */
  get unacknowledged(): number {
    return this.kept.length;
  }

  /** Whether the session is over, from either side. */
  get ended(): boolean {
    return this.over;
  }

  /**
   * attach carries the session on over an open socket, in place of the one
   * before. The far side is told what was heard, then sent everything it
   * has not acknowledged.
   */
  attach(socket: WebSocketLike): void {
    if (this.over) {
      socket.close(CLOSED);
      return;
    }
    const before = this.socket;
    this.socket = socket;
    before?.close(CLOSED);

    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (e) => {
      if (this.socket === socket) this.receive(e.data);
    });
    socket.addEventListener('close', (e) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.over) this.onClose(e.code);
    });

    this.acknowledge(socket);
    for (const { frame } of this.kept) socket.send(join(frame));
  }

  /**
   * end is the session over: the port's close listeners fire once, and a
   * socket still attached is closed.
   */
  end(): void {
    if (this.over) return;
    this.close();
    for (const fn of this.closes) fn();
  }

  private close(): void {
    if (this.over) return;
    this.over = true;
    clearTimeout(this.ackTimer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(CLOSED);
  }

  private send(message: unknown): void {
    if (this.over) return;
    const frame = encode({ seq: this.sent + 1, ack: this.heard, message });
    const weight = frameBytes(frame);
    if (weight > this.limit) {
      throw new Error(
        `${formatBytes(weight)} is over the ${formatBytes(this.limit)} this engine takes in one message`,
      );
    }
    this.sent++;
    this.kept.push({ seq: this.sent, frame });
    this.told = this.heard;
    this.socket?.send(join(frame));
  }

  private receive(data: unknown): void {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (typeof bytes !== 'string' && !(bytes instanceof Uint8Array)) return;
    let got: Carried;
    try {
      got = decode(bytes);
    } catch (err) {
      this.onTrouble(trouble(`${this.far} sent ${messageOf(err)}`));
      return;
    }
    // What the far side has is let go of. An acknowledgement sent again
    // after a drop may be behind one heard before, and lets go of nothing.
    while (this.kept.length > 0 && this.kept[0]!.seq <= got.ack)
      this.kept.shift();
    if (got.seq === undefined) return;
    // Heard already: sent again after a drop.
    if (got.seq <= this.heard) return;
    this.heard = got.seq;
    this.ackTimer ??= setTimeout(() => {
      this.ackTimer = undefined;
      if (this.socket !== undefined && this.told < this.heard)
        this.acknowledge(this.socket);
    }, ACK_DELAY_MS);
    this.deliver(got.message);
  }

  private acknowledge(socket: WebSocketLike): void {
    socket.send(join(encode({ ack: this.heard })));
    this.told = this.heard;
  }

  private deliver(message: unknown): void {
    for (const fn of this.listeners) fn({ data: message });
  }
}

/**
 * socketPort wraps an open web socket as a MessagePortLike, for a session
 * that lives and dies with the one socket. A socket close fires the port's
 * close listeners.
 */
export function socketPort(
  socket: WebSocketLike,
  limit = FRAME_LIMIT,
): MessagePortLike {
  const session = new Session('the engine', limit);
  session.attach(socket);
  return session.port;
}
