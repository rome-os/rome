// Stand-ins for the tests of the speaking module: a TTS server that speaks
// Soniox's protocol, and a clock the test moves by hand.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import type { Schedule } from "./soniox-speaker.js";

/** A message the adapter sent, as parsed JSON. */
export type Sent = Record<string, unknown>;

export interface FakeTts {
  url: string;
  /** Every JSON message the adapter sent, in order, over all connections. */
  received: Sent[];
  connections: () => number;
  /** The `Authorization` header of each connection. */
  authorization: () => (string | undefined)[];
  /** Runs for each message; what it sends back goes to the same connection. */
  onMessage: (message: Sent, reply: (response: object) => void, socket: WebSocket) => void;
  /** Sends to the newest connection. */
  send(response: object): void;
  /** Closes the newest connection from the server's side. */
  drop(code?: number, reason?: string): void;
  /** Refuses the next connections with this HTTP status. */
  refuse(status: number | null): void;
  stop(): Promise<void>;
}

/** Audio as the server sends it: base64 inside JSON. */
export const audioMessage = (streamId: string, pcm: Uint8Array, audioEnd = false): object => ({
  stream_id: streamId,
  audio: Buffer.from(pcm).toString("base64"),
  ...(audioEnd ? { audio_end: true } : {}),
});

export const terminatedMessage = (streamId: string): object => ({
  stream_id: streamId,
  terminated: true,
});

export const errorMessage = (
  streamId: string | undefined,
  code: number,
  type: string,
  message = type,
): object => ({
  ...(streamId === undefined ? {} : { stream_id: streamId }),
  error_code: code,
  error_type: type,
  error_message: message,
});

/** Starts a fake server that does nothing until `onMessage` is set. */
export async function startFakeTts(): Promise<FakeTts> {
  const http: Server = createServer();
  let refusal: number | null = null;
  const wss = new WebSocketServer({
    server: http,
    verifyClient: (_info, done) => {
      if (refusal === null) done(true);
      else done(false, refusal, "refused");
    },
  });
  const sockets: WebSocket[] = [];
  const authorization: (string | undefined)[] = [];
  const fake: FakeTts = {
    url: "",
    received: [],
    connections: () => sockets.length,
    authorization: () => authorization,
    onMessage: () => {},
    send: (response) => sockets.at(-1)?.send(JSON.stringify(response)),
    drop: (code = 1001, reason = "Timeout") => sockets.at(-1)?.close(code, reason),
    refuse: (status) => {
      refusal = status;
    },
    stop: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.terminate();
        wss.close(() => http.close(() => resolve()));
      }),
  };
  wss.on("connection", (socket, request) => {
    sockets.push(socket);
    authorization.push(request.headers.authorization);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Sent;
      fake.received.push(message);
      fake.onMessage(message, (response) => socket.send(JSON.stringify(response)), socket);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  fake.url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/tts-websocket`;
  return fake;
}

export interface FakeClock {
  schedule: Schedule;
  /** Moves time on and runs every timer that falls due, in time order. */
  advance(ms: number): void;
  /** Timers set and not yet run or stopped. */
  pending(): number;
}

export function fakeClock(): FakeClock {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    schedule: (ms, fn) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return () => {
        timers.delete(id);
      };
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers)
          if (entry[1].at <= until && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}

/** Polls until `check` holds, so a test can wait on a real socket. */
export async function until(
  check: () => boolean,
  what = "condition",
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
