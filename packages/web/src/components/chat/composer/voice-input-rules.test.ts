import { describe, expect, it } from "@rstest/core";
import {
  IDLE,
  next,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceState,
} from "./voice-input-rules";

const at = { original: "Hello old world", start: 6, end: 9 };
const listening: VoiceState = { ...IDLE, phase: "listening", anchor: at };
const finishing: VoiceState = { ...listening, phase: "finishing" };
const insertion = { anchor: at, text: "new", spoken: "Hello new world", retry: false };
const waiting: VoiceState = { ...IDLE, waiting: insertion };

type Row = [
  name: string,
  state: VoiceState,
  event: VoiceEvent,
  nextState: Partial<VoiceState>,
  effects: VoiceEffect[],
];

const rows: Row[] = [
  // Starting.
  [
    "start clears the notice and listens",
    IDLE,
    { type: "start", field: at },
    { phase: "listening", anchor: at },
    [{ do: "setNotice", stop: null }, { do: "listen" }],
  ],
  [
    "start drops the wait for a hidden field",
    waiting,
    { type: "start", field: at },
    { phase: "listening", waiting: null },
    [{ do: "unwatchShown" }, { do: "setNotice", stop: null }, { do: "listen" }],
  ],
  ["start while listening does nothing", listening, { type: "start", field: at }, listening, []],
  ["start while finishing does nothing", finishing, { type: "start", field: at }, finishing, []],

  // Hearing.
  [
    "heard text shows at the cursor",
    listening,
    { type: "heard", text: "new" },
    listening,
    [{ do: "write", value: "Hello new world" }],
  ],
  [
    "heard text keeps showing while finishing",
    finishing,
    { type: "heard", text: "new" },
    finishing,
    [{ do: "write", value: "Hello new world" }],
  ],
  ["heard while idle does nothing", IDLE, { type: "heard", text: "late" }, IDLE, []],
  ["asking is remembered", listening, { type: "asking", asking: true }, { asking: true }, []],

  // Stopping.
  [
    "stop waits for the rest of the text",
    listening,
    { type: "stop" },
    { phase: "finishing" },
    [{ do: "stopListening" }],
  ],
  ["stop while finishing does nothing", finishing, { type: "stop" }, finishing, []],
  ["stop while idle does nothing", IDLE, { type: "stop" }, IDLE, []],

  // Done: every way listening ends but leaving.
  [
    "done puts the field back, then inserts the text as one edit",
    finishing,
    { type: "done", text: "new", stop: null },
    { phase: "idle", anchor: null, inserting: insertion },
    [
      { do: "writeNow", value: "Hello old world" },
      { do: "insert", start: 6, end: 9, text: "new" },
      { do: "setNotice", stop: null },
    ],
  ],
  [
    "done with a reason says why",
    { ...listening, asking: true },
    { type: "done", text: "new", stop: { reason: "time-limit" } },
    { phase: "idle", asking: false },
    [
      { do: "writeNow", value: "Hello old world" },
      { do: "insert", start: 6, end: 9, text: "new" },
      { do: "setNotice", stop: { reason: "time-limit" } },
    ],
  ],
  [
    "done with nothing heard leaves the field and selection as they were",
    listening,
    { type: "done", text: "  ", stop: null },
    { phase: "idle", inserting: null },
    [
      { do: "writeNow", value: "Hello old world" },
      { do: "select", start: 6, end: 9 },
      { do: "setNotice", stop: null },
    ],
  ],
  [
    "done while idle does nothing",
    IDLE,
    { type: "done", text: "x", stop: { reason: "connection-lost" } },
    IDLE,
    [],
  ],

  // Leaving: idle again, the words stay where the preview put them.
  [
    "leaving the page ends listening and keeps why with the draft",
    listening,
    { type: "left", reason: "page-reloaded" },
    { phase: "idle", anchor: null },
    [
      { do: "cancelListening" },
      { do: "setNotice", stop: { reason: "page-reloaded" } },
      { do: "keepNotice", stop: { reason: "page-reloaded" } },
    ],
  ],
  [
    "leaving the chat while finishing ends listening too",
    finishing,
    { type: "left", reason: "left-chat" },
    { phase: "idle" },
    [
      { do: "cancelListening" },
      { do: "setNotice", stop: { reason: "left-chat" } },
      { do: "keepNotice", stop: { reason: "left-chat" } },
    ],
  ],
  [
    "leaving the page while idle does nothing",
    waiting,
    { type: "left", reason: "page-reloaded" },
    waiting,
    [],
  ],
  [
    "leaving the chat while idle drops the wait for its field",
    waiting,
    { type: "left", reason: "left-chat" },
    { waiting: null },
    [{ do: "unwatchShown" }],
  ],

  // The native insert.
  [
    "inserted ends the insert",
    { ...IDLE, inserting: insertion },
    { type: "inserted" },
    { inserting: null },
    [],
  ],
  [
    "a hidden field keeps the text and waits to show",
    { ...IDLE, inserting: insertion },
    { type: "insertFailed" },
    { inserting: null, waiting: insertion },
    [{ do: "write", value: "Hello new world" }, { do: "watchShown" }],
  ],
  [
    "a field that still cannot take focus once shown keeps the text",
    { ...IDLE, inserting: { ...insertion, retry: true } },
    { type: "insertFailed" },
    { inserting: null, waiting: null },
    [{ do: "write", value: "Hello new world" }],
  ],
  [
    "a field shown again takes the text as one edit",
    waiting,
    { type: "shown", value: "Hello new world" },
    { waiting: null, inserting: { ...insertion, retry: true } },
    [
      { do: "writeNow", value: "Hello old world" },
      { do: "insert", start: 6, end: 9, text: "new" },
    ],
  ],
  [
    "an edit the guardian made while the field was hidden stands",
    waiting,
    { type: "shown", value: "Hello new world!" },
    { waiting: null, inserting: null },
    [],
  ],

  // The notice.
  [
    "the guardian's edit clears the notice",
    IDLE,
    { type: "edited" },
    IDLE,
    [{ do: "setNotice", stop: null }],
  ],
  [
    "the spoken text going in leaves the notice",
    { ...IDLE, inserting: insertion },
    { type: "edited" },
    {},
    [],
  ],
  [
    "a send clears the notice",
    listening,
    { type: "dismissed" },
    listening,
    [{ do: "setNotice", stop: null }],
  ],
];

describe("next", () => {
  it.each(rows)("%s", (_name, state, event, nextState, effects) => {
    const [after, did] = next(state, event);
    expect(after).toMatchObject(nextState);
    expect(did).toEqual(effects);
  });
});
