import { describe, expect, it } from "@rstest/core";
import { createStore } from "zustand/vanilla";
import { createBehaviorScope } from "./behavior";
import { fakeEditor } from "./fakes";
import { createSpokenInsertion } from "./spoken-insertion";

function setup(value: string, start?: number, end?: number) {
  const { field, editor } = fakeEditor(value, start, end);
  const scope = createBehaviorScope(createStore(() => ({})));
  const insertion = createSpokenInsertion(scope.context, { editor });
  return { field, insertion, destroy: scope.destroy };
}

describe("spoken insertion", () => {
  it("shows the heard text at the cursor while listening", () => {
    const { field, insertion } = setup("Note: world", 6);
    insertion.begin();
    insertion.preview("hello");
    expect(field.value).toBe("Note: hello world");
    insertion.preview("hello there");
    expect(field.value).toBe("Note: hello there world");
  });

  it("inserts the heard text as one typed edit over the field as it was", () => {
    const { field, insertion } = setup("Hello old world", 6, 9);
    insertion.begin();
    insertion.preview("new");
    insertion.commit("new");
    expect(field.inserts).toEqual(["new"]);
    expect(field.value).toBe("Hello new world");
  });

  it("leaves the field and its selection as they were when nothing was heard", () => {
    const { field, insertion } = setup("Hello", 1, 3);
    insertion.begin();
    insertion.preview("um");
    insertion.commit("  ");
    expect(field).toMatchObject({ value: "Hello", start: 1, end: 3, inserts: [] });
  });

  it("keeps the text in a hidden field, then inserts it as one edit once the field shows", () => {
    const { field, insertion } = setup("Note:");
    insertion.begin();
    field.focusable = false;
    insertion.commit("buy milk");
    expect(field.value).toBe("Note: buy milk");
    expect(field.inserts).toEqual([]);

    field.focusable = true;
    field.shown?.();
    expect(field.inserts).toEqual([" buy milk"]);
    expect(field.value).toBe("Note: buy milk");
  });

  it("lets an edit the guardian made while the field was hidden stand", () => {
    const { field, insertion } = setup("");
    insertion.begin();
    field.focusable = false;
    insertion.commit("hello");
    field.value = "hello!";
    field.focusable = true;
    field.shown?.();
    expect(field.value).toBe("hello!");
    expect(field.inserts).toEqual([]);
  });

  it("claims the insert's own edit only while it goes in", () => {
    const { field, insertion } = setup("");
    const seen: boolean[] = [];
    field.onInsert = () => seen.push(insertion.isInserting());
    insertion.begin();
    insertion.commit("hello");
    expect(seen).toEqual([true]);
    expect(insertion.isInserting()).toBe(false);
  });

  it("stops waiting for a hidden field when listening starts again or the field goes", () => {
    const { field, insertion, destroy } = setup("");
    insertion.begin();
    field.focusable = false;
    insertion.commit("one");
    insertion.begin();
    expect(field.waitsCancelled).toBe(1);

    insertion.commit("two");
    destroy();
    expect(field.waitsCancelled).toBe(2);
  });
});
