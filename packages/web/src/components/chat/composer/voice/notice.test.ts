import { describe, expect, it } from "@rstest/core";
import { createStore } from "zustand/vanilla";
import type { DictationStop } from "@/lib/voice-input/dictation";
import { createBehaviorScope } from "./behavior";
import { createNotice } from "./notice";

function setup() {
  const draft = { notice: null as DictationStop | null, kept: [] as DictationStop[] };
  let own = false;
  const scope = createBehaviorScope(createStore(() => ({})));
  const notice = createNotice(scope.context, {
    draft: {
      set: (stop) => {
        draft.notice = stop;
      },
      keep: (stop) => draft.kept.push(stop),
    },
    ownEdit: () => own,
  });
  return { notice, draft, setOwn: (value: boolean) => (own = value) };
}

describe("notice", () => {
  it("shows why listening stopped and saves it with the draft at once", () => {
    const { notice, draft } = setup();
    notice.show({ reason: "connection-lost" });
    expect(draft.notice).toEqual({ reason: "connection-lost" });
    expect(draft.kept).toEqual([{ reason: "connection-lost" }]);
  });

  it("shows nothing after the guardian's own stop", () => {
    const { notice, draft } = setup();
    notice.show({ reason: "time-limit" });
    notice.show(null);
    expect(draft.notice).toBeNull();
    expect(draft.kept).toHaveLength(1);
  });

  it("goes away on the guardian's edit or a send, but not on the spoken text going in", () => {
    const { notice, draft, setOwn } = setup();
    notice.show({ reason: "time-limit" });
    setOwn(true);
    notice.edited();
    expect(draft.notice).toEqual({ reason: "time-limit" });

    setOwn(false);
    notice.edited();
    expect(draft.notice).toBeNull();

    notice.show({ reason: "time-limit" });
    notice.clear();
    expect(draft.notice).toBeNull();
  });
});
