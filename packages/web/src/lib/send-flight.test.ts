// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { discardSendOrigin, recordSendOrigin, takeSendOrigin } from "./send-flight";

function textarea(): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  el.style.paddingRight = "4px";
  el.style.paddingBottom = "6px";
  el.getBoundingClientRect = () =>
    ({ left: 100, top: 500, right: 600, bottom: 540, width: 500, height: 40 }) as DOMRect;
  document.body.append(el);
  return el;
}

afterEach(() => {
  rs.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("send flight origins", () => {
  it("hands the text box corner to one bubble, then forgets it", () => {
    recordSendOrigin("input-1", textarea());

    expect(takeSendOrigin("input-1")).toEqual({ right: 596, bottom: 534 });
    expect(takeSendOrigin("input-1")).toBeNull();
  });

  it("returns nothing for an input the composer never sent", () => {
    expect(takeSendOrigin("input-unknown")).toBeNull();
  });

  it("drops an origin once the send has failed", () => {
    recordSendOrigin("input-2", textarea());
    discardSendOrigin("input-2");

    expect(takeSendOrigin("input-2")).toBeNull();
  });

  it("lets an origin expire, so a late bubble appears in place", () => {
    const now = rs.spyOn(performance, "now").mockReturnValue(1_000);
    recordSendOrigin("input-3", textarea());
    now.mockReturnValue(1_000 + 16_000);

    expect(takeSendOrigin("input-3")).toBeNull();
  });
});
