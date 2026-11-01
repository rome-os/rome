import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { readPeopleSearchPage } from "./people-search-page.mjs";

// The web test workspace owns jsdom.
const { JSDOM } = createRequire(new URL("../../packages/web/package.json", import.meta.url))(
  "jsdom",
);

const SEARCH_URL = "https://www.linkedin.com/search/results/people/?keywords=example";

// jsdom has no layout, so innerText follows the rule Chromium applies to these fixtures: hidden
// nodes drop out, display:contents and inline boxes join their parent's line, and every other
// box starts and ends a line.
function installInnerText(window) {
  const render = (node) => {
    if (node.nodeType === window.Node.TEXT_NODE) return node.data.replace(/\s+/g, " ");
    if (node.nodeType !== window.Node.ELEMENT_NODE) return "";
    const style = window.getComputedStyle(node);
    if (node.hidden || style.display === "none" || style.visibility === "hidden") return "";
    const inner = Array.from(node.childNodes, render).join("");
    if (style.display === "contents" || style.display.startsWith("inline")) return inner;
    return `\n${inner}\n`;
  };
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return render(this)
        .split("\n")
        .map((line) => line.replace(/ +/g, " ").trim())
        .filter(Boolean)
        .join("\n");
    },
  });
}

function makeDom(html, url = SEARCH_URL) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  installInnerText(dom.window);
  return dom;
}

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/people-search/${name}.html`, import.meta.url), "utf8");

function read(dom) {
  return JSON.parse(JSON.stringify(dom.window.eval(`(${readPeopleSearchPage.toString()})()`)));
}

const profile = (handle) => `https://www.linkedin.com/in/${handle}/`;

test("same-name results each keep their own headline and location", () => {
  const dom = makeDom(fixture("same-name"));
  const before = dom.window.document.documentElement.outerHTML;

  const result = read(dom);

  assert.deepEqual(result.rows, [
    {
      name: "Alex Rivera",
      headline: "Staff Engineer at Example Corp",
      location: "Austin, Texas, United States",
      profile_url: profile("alex-rivera-a1"),
    },
    {
      name: "Alex Rivera",
      headline: "Product Designer at Example Corp",
      location: "Lisbon, Portugal",
      profile_url: profile("alex-rivera-b2"),
    },
    {
      name: "Alex Rivera",
      headline: "Data Analyst at Example Corp",
      location: "",
      profile_url: profile("alex-rivera-c3"),
    },
    {
      name: "Alex Rivera",
      headline: "",
      location: "",
      profile_url: profile("alex-rivera-d4"),
    },
    {
      name: "Alex Rivera",
      headline: "Engineering Manager at Example Corp",
      location: "Toronto, Ontario, Canada",
      profile_url: profile("alex-rivera-e5"),
    },
  ]);
  assert.equal(result.candidate_count, 6);
  assert.equal(result.resolved_count, 5);
  assert.equal(
    dom.window.document.documentElement.outerHTML,
    before,
    "the read leaves the page as it found it",
  );
});

test("results without card wrappers stop at the next result and at the end of the list", () => {
  const result = read(makeDom(fixture("flattened")));

  assert.deepEqual(result.rows, [
    {
      name: "Sam Placeholder",
      headline: "Founder at Example Studio",
      location: "Denver, Colorado, United States",
      profile_url: profile("sam-placeholder-1"),
    },
    {
      name: "Sam Placeholder",
      headline: "Teacher at Example School",
      location: "",
      profile_url: profile("sam-placeholder-2"),
    },
    {
      name: "Casey Sample",
      headline: "Recruiter at Example Talent",
      location: "",
      profile_url: profile("casey-sample"),
    },
  ]);
});

test("a name wrapped across lines resolves even when presence text renders first", () => {
  const result = read(makeDom(fixture("split-name")));

  assert.deepEqual(result.rows, [
    {
      name: "Jordan Example",
      headline: "Head of Partnerships at Example Logistics",
      location: "Nairobi, Kenya",
      profile_url: profile("jordan-example"),
    },
  ]);
});

test("a link wrapping the whole card yields its name and metadata", () => {
  const result = read(makeDom(fixture("card-link")));

  assert.deepEqual(result.rows, [
    {
      name: "Riley Test",
      headline: "Nurse Practitioner at Example Health",
      location: "Leeds, England, United Kingdom",
      profile_url: profile("riley-test"),
    },
    {
      name: "Quinn Demo",
      headline: "Chef at Example Bistro",
      location: "Osaka, Japan",
      profile_url: profile("quinn-demo"),
    },
  ]);
});

test("unknown name labels resolve by their shared shape and skip mutual-connection links", () => {
  const result = read(makeDom(fixture("lenient")));

  assert.equal(result.layout, "lenient");
  assert.deepEqual(
    result.rows.map((row) => [row.profile_url, row.headline, row.location]),
    [
      [
        profile("camille-exemple"),
        "Architecte chez Exemple SA",
        "Bordeaux, Nouvelle-Aquitaine, France",
      ],
      [
        profile("dominique-test"),
        "Comptable chez Exemple Conseil",
        "Nantes, Pays de la Loire, France",
      ],
    ],
  );
});

test("profile links that only appear inside sentences produce no rows", () => {
  const result = read(makeDom(fixture("unsupported")));

  assert.deepEqual(result, { rows: [], candidate_count: 2, resolved_count: 0, layout: "none" });
});

test("a page without profile links reports no candidates", () => {
  const result = read(makeDom(fixture("empty")));

  assert.deepEqual(result, { rows: [], candidate_count: 0, resolved_count: 0, layout: "none" });
});

test("duplicated leading names collapse and localized degree badges are accepted", () => {
  const result = read(
    makeDom(`<!doctype html><main><ul><li>
      <a href="/in/micah-example/"><span aria-hidden="true">Micah Example Micah Example • 3度+</span></a>
      <div>Co-Founder and CEO</div>
      <div>London, England, United Kingdom</div>
    </li></ul></main>`),
  );

  assert.deepEqual(result.rows, [
    {
      name: "Micah Example",
      headline: "Co-Founder and CEO",
      location: "London, England, United Kingdom",
      profile_url: profile("micah-example"),
    },
  ]);
});

test("hidden duplicates and links off LinkedIn never become rows", () => {
  const result = read(
    makeDom(`<!doctype html><main><ul>
      <li style="display: none">
        <a href="/in/hidden-duplicate/"><span aria-hidden="true">Hidden Duplicate</span></a>
        <div>Should Not Appear</div>
      </li>
      <li>
        <a href="https://example.com/in/offsite-person/"><span aria-hidden="true">Offsite Person</span></a>
        <div>Should Not Appear Either</div>
      </li>
      <li>
        <a href="/in/visible-person/"><span aria-hidden="true">Visible Person</span></a>
        <div>Analyst at Example Bank</div>
        <div>Dublin, Ireland</div>
      </li>
    </ul></main>`),
  );

  assert.deepEqual(result.rows, [
    {
      name: "Visible Person",
      headline: "Analyst at Example Bank",
      location: "Dublin, Ireland",
      profile_url: profile("visible-person"),
    },
  ]);
});

test("pages other than people search report where the browser landed", () => {
  const result = read(makeDom("<main></main>", "https://www.linkedin.com/feed/"));

  assert.deepEqual(result, {
    error: "not on people search page",
    url: "https://www.linkedin.com/feed/",
  });
});
