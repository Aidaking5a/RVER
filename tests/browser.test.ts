import test from "node:test";
import assert from "node:assert/strict";
import { ConversationStream } from "../public/stream.js";

test("chat streaming rejects duplicate sends and fences a stopped conversation’s late reply", async () => {
  let resolve!: (response: Response) => void;
  let calls = 0;
  const events: unknown[] = [];
  const states: boolean[] = [];
  const stream = new ConversationStream({
    onEvent: (e: unknown) => events.push(e),
    onState: (state: boolean) => states.push(state),
    onError: () => assert.fail("Unexpected error"),
    fetcher: async () => {
      calls++;
      return new Promise<Response>((r) => {
        resolve = r;
      });
    },
  });
  const first = stream.start("/stream", { message: "first" });
  assert.equal(await stream.start("/stream", { message: "duplicate" }), false);
  assert.equal(calls, 1);
  stream.stop();
  resolve(
    new Response(
      'data: {"type":"delta","token":"late reply"}\n\ndata: {"type":"done"}\n\n',
    ),
  );
  await first;
  assert.equal(events.length, 0);
  assert.equal(states.at(-1), false);
});

test("fragmented UTF-8 streams complete and failed/truncated streams always clear busy state", async () => {
  const encoded = new TextEncoder().encode(
    'data: {"type":"delta","token":"日本語"}\n\ndata: {"type":"done"}\n\n',
  );
  const events: { type: string; token?: string }[] = [];
  const errors: Error[] = [];
  const states: boolean[] = [];
  const options = {
    onEvent: (event: { type: string; token?: string }) => events.push(event),
    onError: (error: Error) => errors.push(error),
    onState: (state: boolean) => states.push(state),
  };
  const stream = new ConversationStream({
    ...options,
    fetcher: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < encoded.length; i += 7)
              controller.enqueue(encoded.slice(i, i + 7));
            controller.close();
          },
        }),
      ),
  });
  assert.equal(await stream.start("/", {}), true);
  assert.equal(events[0]?.token, "日本語");
  const truncated = new ConversationStream({
    ...options,
    fetcher: async () =>
      new Response('data: {"type":"delta","token":"partial"}\n\n'),
  });
  assert.equal(await truncated.start("/", {}), false);
  assert.match(errors.at(-1)!.message, /before.*completed/);
  assert.equal(states.at(-1), false);
});

test("navigation blocks sends until the latest history loads and native fetch is called unbound", async () => {
  let calls = 0;
  const states: boolean[] = [];
  const stream = new ConversationStream({
    onEvent() {},
    onState: (busy: boolean) => states.push(busy),
    onError: (error: Error) => assert.fail(error.message),
    fetcher: async function (this: unknown) {
      assert.equal(this, undefined);
      calls++;
      return new Response('data: {"type":"done"}\n\n');
    },
  });
  const firstNavigation = stream.beginNavigation();
  assert.equal(await stream.start("/", { message: "too early" }), false);
  const secondNavigation = stream.beginNavigation();
  assert.equal(stream.endNavigation(firstNavigation), false);
  assert.equal(await stream.start("/", {}), false);
  assert.equal(stream.endNavigation(secondNavigation), true);
  assert.equal(await stream.start("/", {}), true);
  assert.equal(calls, 1);
  assert.equal(states.at(-1), false);
});
