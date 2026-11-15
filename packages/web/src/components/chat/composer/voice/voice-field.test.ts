import { describe, expect, it } from "@rstest/core";
import { createStore } from "zustand/vanilla";
import type { DictationStop } from "@/lib/voice-input/dictation";
import { fakeEditor, fakePage, fakeTranscriber } from "./fakes";
import { createVoiceField, type VoiceFieldState } from "./voice-field";

// Each test checks one callback the wiring passes between behaviors.
function setup(value = "") {
  const store = createStore<VoiceFieldState>(() => ({ phase: "idle", asking: false }));
  const { field, editor } = fakeEditor(value);
  const fake = fakeTranscriber();
  const page = fakePage();
  const draft = { notice: null as DictationStop | null };
  const voice = createVoiceField(store, {
    editor,
    transcriber: fake.transcriber,
    draft: {
      set: (stop) => {
        draft.notice = stop;
      },
      keep: () => {},
    },
    page: page.page,
  });
  return { store, field, fake, page, draft, voice };
}

describe("voice field wiring", () => {
  it("started: marks the cursor and clears the notice", () => {
    const { voice, field, fake, draft } = setup("Note:");
    draft.notice = { reason: "time-limit" };
    voice.listening.start();
    fake.last().handlers.onText("hi");
    expect(field.value).toBe("Note: hi");
    expect(draft.notice).toBeNull();
  });

  it("ended: inserts what was heard and shows why", () => {
    const { voice, field, fake, draft } = setup();
    voice.listening.start();
    fake.last().handlers.onDone("hello", { reason: "time-limit" });
    expect(field.inserts).toEqual(["hello"]);
    expect(draft.notice).toEqual({ reason: "time-limit" });
  });

  it("ownEdit: the spoken text going in does not clear the notice", () => {
    const { voice, field, fake, draft } = setup();
    voice.listening.start();
    field.focusable = false;
    fake.last().handlers.onDone("hello", { reason: "time-limit" });
    field.onInsert = () => voice.notice.edited();
    field.focusable = true;
    field.shown?.();
    expect(field.inserts).toEqual(["hello"]);
    expect(draft.notice).toEqual({ reason: "time-limit" });
  });

  it("hidden: stops listening as the stop control does", () => {
    const { voice, store, fake } = setup();
    voice.listening.start();
    voice.presence.shown(false);
    expect(store.getState().phase).toBe("finishing");
    expect(fake.last().stopped).toBe(1);
  });

  it("left: leaving the page ends listening through the same exit as any stop", () => {
    const { voice, store, page, field, draft } = setup();
    voice.listening.start();
    page.hide();
    expect(store.getState().phase).toBe("idle");
    expect(draft.notice).toEqual({ reason: "page-reloaded" });
    expect(field.value).toBe("");
  });

  it("left: leaving the chat ends listening before the other behaviors clean up", () => {
    const { voice, fake, draft } = setup();
    voice.listening.start();
    fake.last().handlers.onText("half a");
    voice.destroy();
    expect(fake.last().cancelled).toBe(1);
    expect(draft.notice).toEqual({ reason: "left-chat" });
  });
});
