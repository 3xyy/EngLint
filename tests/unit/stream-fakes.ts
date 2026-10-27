import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import { streamEvents, type StreamedMessage } from '../e2e/mock-anthropic';

/** A stream that stops part-way: these events arrive, then `error`, or with no error the stream just ends. */
export interface BrokenReply {
  events: object[];
  error?: unknown;
}

/**
 * A real MessageStream (the SDK's own accumulator) fed from `reply`: the events of the message it resolves to,
 * or a broken reply's events and then its error (or its end). A `reply` that rejects fails the stream before
 * message_start.
 * Events are handed over one read at a time, so an error never drops the events before it.
 */
export function fakeStream(reply: Promise<StreamedMessage | BrokenReply>): MessageStream {
  const enc = new TextEncoder();
  let events: object[] | null = null;
  let broken: BrokenReply | null = null;
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (events === null) {
        try {
          const r = await reply;
          broken = 'events' in r ? r : null;
          events = broken ? broken.events : streamEvents(r as StreamedMessage);
        } catch (err) {
          controller.error(err);
          return;
        }
      }
      if (next < events.length) controller.enqueue(enc.encode(`${JSON.stringify(events[next++])}\n`));
      else if (broken && 'error' in broken) controller.error(broken.error);
      else controller.close();
    },
  });
  return MessageStream.fromReadableStream(body);
}

/** The server-sent events body the API streams for `msg`. */
export function sseBody(msg: StreamedMessage): string {
  return streamEvents(msg)
    .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
}

/** The first `n` events of `msg`'s stream: message_start, then block events. */
export const firstEvents = (msg: StreamedMessage, n: number) => streamEvents(msg).slice(0, n);
