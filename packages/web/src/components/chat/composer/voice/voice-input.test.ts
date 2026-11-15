import { describe, expect, it } from "@rstest/core";
import type { DictationStop } from "@/lib/voice-input/dictation";
import { fakeEditor, fakePage, fakeTranscriber } from "./fakes";
import { createVoiceInput } from "./voice-input";

function setup(value = "", start?: number, end?: number) {
  const { field, editor } = fakeEditor(value, start, end);
  const fake = fakeTranscriber();
  const page = fakePage();
  const draft = { notice: null as DictationStop | null, kept: [] as DictationStop[] };
  const voice = createVoiceInput({
    editor,
    transcriber: fake.transcriber,
    draft: {
      set: (stop) => {
        draft.notice = stop;
      },
      keep: (stop) => draft.kept.push(stop),
    },
    page: page.page,
  });
  return { voice, field, fake, page, draft, phase: () => voice.view().phase };
}

describe("listening", () => {
  it("listens once at a time", () => {
    const { voice, fake, phase } = setup();
    voice.start();
    voice.start();
    expect(phase()).toBe("listening");
    expect(fake.dictations).toHaveLength(1);
  });

  it("waits for the rest of the text after a stop, then is idle with no notice", () => {
    const { voice, fake, phase, draft } = setup();
    voice.start();
    voice.stop();
    expect(phase()).toBe("finishing");
    expect(fake.last().stopped).toBe(1);

    fake.last().handlers.onDone("hello", null);
    expect(phase()).toBe("idle");
    expect(draft.notice).toBeNull();
  });

  it("is idle and says why when the transcriber stops listening on its own", () => {
    const { voice, fake, phase, draft } = setup();
    voice.start();
    fake.last().handlers.onDone("half", { reason: "time-limit" });
    expect(phase()).toBe("idle");
    expect(draft.notice).toEqual({ reason: "time-limit" });
    expect(draft.kept).toEqual([]);
  });

  it("is idle again when the transcriber ends before it returns", () => {
    const { field, editor } = fakeEditor();
    const fake = fakeTranscriber();
    const voice = createVoiceInput({
      editor,
      transcriber: (handlers) => {
        const dictation = fake.transcriber(handlers);
        handlers.onDone("", { reason: "microphone-blocked" });
        return dictation;
      },
      draft: { set() {}, keep() {} },
      page: fakePage().page,
    });
    voice.start();
    expect(voice.view().phase).toBe("idle");
    voice.start();
    expect(fake.dictations).toHaveLength(2);
    expect(field.inserts).toEqual([]);
  });

  it("says while the browser asks for the microphone", () => {
    const { voice, fake } = setup();
    voice.start();
    fake.last().handlers.onAsking?.(true);
    expect(voice.view().asking).toBe(true);
    fake.last().handlers.onDone("", { reason: "microphone-blocked" });
    expect(voice.view().asking).toBe(false);
  });

  it("does nothing on a stop or a hidden field while idle", () => {
    const { voice, phase } = setup();
    voice.stop();
    voice.shown(false);
    expect(phase()).toBe("idle");
  });

  it("stops as the stop control does when the field is hidden", () => {
    const { voice, fake, phase } = setup();
    voice.start();
    voice.shown(true);
    expect(phase()).toBe("listening");
    voice.shown(false);
    expect(phase()).toBe("finishing");
    expect(fake.last().stopped).toBe(1);
  });

  it("tells subscribers each time the view changes", () => {
    const { voice } = setup();
    const seen: string[] = [];
    voice.subscribe(() => seen.push(voice.view().phase));
    voice.start();
    voice.stop();
    expect(seen).toEqual(["listening", "finishing"]);
  });
});

describe("spoken insertion", () => {
  it("shows the heard text at the cursor while listening", () => {
    const { voice, field, fake } = setup("Note: world", 6);
    voice.start();
    fake.last().handlers.onText("hello");
    expect(field.value).toBe("Note: hello world");
    fake.last().handlers.onText("hello there");
    expect(field.value).toBe("Note: hello there world");
  });

  it("inserts the heard text as one typed edit over the field as it was", () => {
    const { voice, field, fake } = setup("Hello old world", 6, 9);
    voice.start();
    fake.last().handlers.onText("new");
    fake.last().handlers.onDone("new", null);
    expect(field.inserts).toEqual(["new"]);
    expect(field.value).toBe("Hello new world");
  });

  it("leaves the field and its selection as they were when nothing was heard", () => {
    const { voice, field, fake } = setup("Hello", 1, 3);
    voice.start();
    fake.last().handlers.onText("um");
    fake.last().handlers.onDone("  ", null);
    expect(field).toMatchObject({ value: "Hello", start: 1, end: 3, inserts: [] });
  });

  it("keeps the text in a hidden field, then inserts it as one edit once the field shows", () => {
    const { voice, field, fake } = setup("Note:");
    voice.start();
    field.focusable = false;
    fake.last().handlers.onDone("buy milk", null);
    expect(field.value).toBe("Note: buy milk");
    expect(field.inserts).toEqual([]);

    field.focusable = true;
    field.shown?.();
    expect(field.inserts).toEqual([" buy milk"]);
    expect(field.value).toBe("Note: buy milk");
  });

  it("lets an edit the guardian made while the field was hidden stand", () => {
    const { voice, field, fake } = setup();
    voice.start();
    field.focusable = false;
    fake.last().handlers.onDone("hello", null);
    field.value = "hello!";
    field.focusable = true;
    field.shown?.();
    expect(field.value).toBe("hello!");
    expect(field.inserts).toEqual([]);
  });

  it("stops waiting for a hidden field when listening starts again or the field goes", () => {
    const { voice, field, fake } = setup();
    voice.start();
    field.focusable = false;
    fake.last().handlers.onDone("one", null);
    voice.start();
    expect(field.waitsCancelled).toBe(1);

    fake.last().handlers.onDone("two", null);
    voice.destroy();
    expect(field.waitsCancelled).toBe(2);
  });
});

describe("notice", () => {
  it("clears when listening starts", () => {
    const { voice, draft } = setup();
    draft.notice = { reason: "time-limit" };
    voice.start();
    expect(draft.notice).toBeNull();
  });

  it("goes away on the guardian's edit or a send", () => {
    const { voice, draft } = setup();
    draft.notice = { reason: "time-limit" };
    voice.noticeEdited();
    expect(draft.notice).toBeNull();
    draft.notice = { reason: "time-limit" };
    voice.dismissNotice();
    expect(draft.notice).toBeNull();
  });

  it("stays when the edit is the spoken text going in", () => {
    const { voice, field, fake, draft } = setup();
    voice.start();
    field.focusable = false;
    fake.last().handlers.onDone("hello", { reason: "time-limit" });
    field.onInsert = () => voice.noticeEdited();
    field.focusable = true;
    field.shown?.();
    expect(field.inserts).toEqual(["hello"]);
    expect(draft.notice).toEqual({ reason: "time-limit" });
  });
});

describe("leaving", () => {
  it("is idle after the page goes away, keeps the words without touching the field, and listens again", () => {
    const { voice, field, fake, page, draft, phase } = setup("Note:");
    voice.start();
    fake.last().handlers.onText("你好");
    page.hide();
    expect(fake.last().cancelled).toBe(1);
    expect(phase()).toBe("idle");
    expect(field.value).toBe("Note:你好");
    expect(field.inserts).toEqual([]);
    expect(draft.notice).toEqual({ reason: "page-reloaded" });
    expect(draft.kept).toEqual([{ reason: "page-reloaded" }]);

    // A page restored from the back/forward cache listens again.
    voice.start();
    expect(phase()).toBe("listening");
    expect(fake.dictations).toHaveLength(2);
  });

  it("keeps the words and says why when the chat goes, then stops watching the page", () => {
    const { voice, field, fake, page, draft } = setup();
    voice.start();
    fake.last().handlers.onText("half a");
    voice.destroy();
    expect(fake.last().cancelled).toBe(1);
    expect(field.inserts).toEqual([]);
    expect(draft.kept).toEqual([{ reason: "left-chat" }]);
    expect(page.listeners.size).toBe(0);
  });

  it("keeps nothing when it leaves while idle", () => {
    const { voice, page, draft } = setup();
    page.hide();
    voice.destroy();
    expect(draft.kept).toEqual([]);
  });
});
