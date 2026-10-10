// Rome testkit — boot the real wiring, fake only the edges.
//
// Edge litmus test: fake it only if it crosses the process boundary (model
// API, chat-network SDK, wall clock, outbound HTTP, subprocess fork).
// Everything else — repos, engines, managers, loaders — is cheap to run for
// real on in-memory SQLite, and tests should assert outcomes (DB rows,
// outbound messages, prompts the model saw), not stub call shapes.
//
// See README.md in this directory. Tracking: amantru/rome-internal#763.

export { createTestRome } from "./test-rome.js";
export type {
  TestRome,
  TestRomeOptions,
  TestRomeRepos,
  TestRomeSeed,
  ActionExecutionPayload,
} from "./test-rome.js";

export {
  FakeModel,
  text,
  thinking,
  result,
  errorMessage,
  invokeAction,
} from "./fake-model.js";
export type { ReplyStep, ReplyBuilder, ActionCallStep } from "./fake-model.js";

export { FakeChannelEndpoint } from "./fake-channel.js";
export type { SentMessage } from "../helpers.js";

export { FakeTelegramApi } from "./fake-telegram.js";
export type { TelegramApiCall } from "./fake-telegram.js";

export { FakeClock, installTestClock, parseDuration } from "./clock.js";
export type { TestClock } from "./clock.js";
export { systemClock } from "../../lib/clock.js";
export type { Clock, ClockTimer } from "../../lib/clock.js";

export { buildAction, recordingAction } from "./builders.js";
export type { BuildActionOverrides, RecordingAction } from "./builders.js";

export { createFetchRecorder, FetchRecorderUnmatchedError } from "./fetch-recorder.js";
export type { FetchRecorder, FetchRule, RecordedFetchCall } from "./fetch-recorder.js";
