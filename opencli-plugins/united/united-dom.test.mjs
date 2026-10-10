import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { readUnitedPage } from "./united-page.mjs";

// Reuse the repository's web-test dependency without adding a plugin runtime dependency.
const { JSDOM } = createRequire(new URL("../../packages/web/package.json", import.meta.url))(
  "jsdom",
);
const html = readFileSync(new URL("./fixtures/responsive.html", import.meta.url), "utf8");

export function addResponsiveDuplicates(document) {
  const desktop = document.querySelector('[data-layout="desktop"]');
  const second = desktop.firstElementChild.cloneNode(true);
  second.querySelector('[class*="departTime--"] span').textContent = "6:00 AM";
  second.style.cssText = "position:absolute; top:5000px";
  desktop.append(second);
  const mobile = document.querySelector('[data-layout="mobile"]');
  mobile.innerHTML = desktop.innerHTML;
  const extras = document.querySelector("[data-hidden-extras]");
  for (const variant of ["display", "visibility", "hidden", "aria"]) {
    const duplicate = desktop.firstElementChild.cloneNode(true);
    if (variant === "display") duplicate.style.display = "none";
    if (variant === "visibility") duplicate.style.visibility = "hidden";
    if (variant === "hidden") duplicate.hidden = true;
    if (variant === "aria") duplicate.setAttribute("aria-hidden", "true");
    extras.append(duplicate);
    const hiddenFare = desktop.querySelector('[aria-describedby="FIRST"]').cloneNode(true);
    if (variant === "display") hiddenFare.style.display = "none";
    if (variant === "visibility") hiddenFare.style.visibility = "hidden";
    if (variant === "hidden") hiddenFare.hidden = true;
    if (variant === "aria") hiddenFare.setAttribute("aria-hidden", "true");
    desktop.firstElementChild.append(hiddenFare);
  }
}

for (const layout of ["desktop", "mobile"]) {
  test(`reads only displayed flight rows and fare cells in the ${layout} DOM`, () => {
    const dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: "https://www.united.com/en/us/fsr/choose-flights",
    });
    try {
      const { window } = dom;
      // jsdom implements DOM/CSS selectors, not layout. Supply boxes and innerText for the fixture.
      window.HTMLElement.prototype.getClientRects = function () {
        for (let element = this; element; element = element.parentElement) {
          if (element.hidden || window.getComputedStyle(element).display === "none") return [];
        }
        return [{}];
      };
      Object.defineProperty(window.HTMLElement.prototype, "innerText", {
        get() {
          return this.textContent;
        },
      });
      addResponsiveDuplicates(window.document);
      for (const element of window.document.querySelectorAll("[data-layout]")) {
        element.style.display = element.dataset.layout === layout ? "block" : "none";
      }
      const data = JSON.parse(JSON.stringify(window.eval(`(${readUnitedPage.toString()})()`)));
      assert.ok(window.document.querySelectorAll('[role="row"]').length > data.rows.length);
      assert.equal(data.rows.length, 2);
      assert.deepEqual(
        data.rows.map((row) => row.departure),
        ["5:00 AM", "6:00 AM"],
      );
      for (const row of data.rows) {
        assert.deepEqual(
          row.fares.map((fare) => fare.money_text),
          ["$192", "$719"],
        );
        assert.deepEqual(
          row.fares.map((fare) => fare.product),
          ["United Economy", "United First"],
        );
      }
      assert.deepEqual(data.displayed, [2, 5]);
    } finally {
      dom.window.close();
    }
  });
}
