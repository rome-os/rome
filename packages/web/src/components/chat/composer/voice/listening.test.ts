import { describe, expect, it, rs } from "@rstest/core";
import { createStore } from "zustand/vanilla";
import { createBehaviorScope } from "./behavior";
import { fakeTranscriber } from "./fakes";
import { createListening, type ListeningState } from "./listening";

function setup() {
  const store = createStore<ListeningState>(() => ({ phase: "idle", asking: false }));
  const scope = createBehaviorScope(store);
  const fake = fakeTranscriber();
  const started = rs.fn();
  const heard = rs.fn();
  const ended = rs.fn();
  const listening = createListening(scope.context, {
    transcriber: fake.transcriber,
    started,
    heard,
    ended,
  });
  return { store, listening, fake, started, heard, ended, destroy: scope.destroy };
}

describe("listening", () => {
  it("listens once at a time and passes on what it hears", () => {
    const { store, listening, fake, started, heard } = setup();
    listening.start();
    listening.start();
    expect(store.getState().phase).toBe("listening");
    expect(started).toHaveBeenCalledOnce();
    expect(fake.dictations).toHaveLength(1);

    fake.last().handlers.onText("hello");
    expect(heard).toHaveBeenCalledWith("hello");
  });

  it("waits for the rest of the text after a stop, then ends with no reason", () => {
    const { store, listening, fake, ended } = setup();
    listening.start();
    listening.stop();
    expect(store.getState().phase).toBe("finishing");
    expect(fake.last().stopped).toBe(1);
    expect(ended).not.toHaveBeenCalled();

    fake.last().handlers.onDone("hello there", null);
    expect(store.getState().phase).toBe("idle");
    expect(ended).toHaveBeenCalledWith("hello there", null);
  });

  it("ends with the transcriber's reason when it stops listening on its own", () => {
    const { store, listening, fake, ended } = setup();
    listening.start();
    fake.last().handlers.onDone("half", { reason: "time-limit" });
    expect(store.getState().phase).toBe("idle");
    expect(ended).toHaveBeenCalledWith("half", { reason: "time-limit" });
  });

  it("ends at once for a stated reason, and can listen again after", () => {
    const { store, listening, fake, ended } = setup();
    listening.start();
    fake.last().handlers.onText("你好");
    listening.end("page-reloaded");
    expect(fake.last().cancelled).toBe(1);
    expect(store.getState().phase).toBe("idle");
    expect(ended).toHaveBeenCalledWith("你好", { reason: "page-reloaded" });

    // A page restored from the back/forward cache listens again.
    listening.start();
    expect(store.getState().phase).toBe("listening");
    expect(fake.dictations).toHaveLength(2);
  });

  it("does nothing on a stop or an end while idle", () => {
    const { store, listening, ended } = setup();
    listening.stop();
    listening.end("left-chat");
    expect(store.getState().phase).toBe("idle");
    expect(ended).not.toHaveBeenCalled();
  });

  it("is idle again when the transcriber ends before it returns", () => {
    const store = createStore<ListeningState>(() => ({ phase: "idle", asking: false }));
    const fake = fakeTranscriber();
    const ended = rs.fn();
    const listening = createListening(createBehaviorScope(store).context, {
      transcriber: (handlers) => {
        const dictation = fake.transcriber(handlers);
        handlers.onDone("", { reason: "microphone-blocked" });
        return dictation;
      },
      started() {},
      heard() {},
      ended,
    });
    listening.start();
    expect(store.getState().phase).toBe("idle");
    listening.start();
    expect(fake.dictations).toHaveLength(2);
    expect(ended).toHaveBeenCalledTimes(2);
  });

  it("says while the browser asks for the microphone", () => {
    const { store, listening, fake } = setup();
    listening.start();
    fake.last().handlers.onAsking?.(true);
    expect(store.getState().asking).toBe(true);
    fake.last().handlers.onDone("", { reason: "microphone-blocked" });
    expect(store.getState().asking).toBe(false);
  });

  it("drops the dictation without ending when the component goes", () => {
    const { listening, fake, ended, destroy } = setup();
    listening.start();
    destroy();
    expect(fake.last().cancelled).toBe(1);
    expect(ended).not.toHaveBeenCalled();
  });
});
