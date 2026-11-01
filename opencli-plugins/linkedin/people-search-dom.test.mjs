import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { CommandExecutionError } from "@jackwener/opencli/errors";
import { peopleSearchRows } from "./people-search-helpers.mjs";
import { readPeopleSearchPage } from "./people-search-page.mjs";

// The web test workspace owns jsdom.
const { JSDOM } = createRequire(new URL("../../packages/web/package.json", import.meta.url))(
  "jsdom",
);

const SEARCH_URL = "https://www.linkedin.com/search/results/people/?keywords=example";

// jsdom has no layout, so innerText follows the rule Chromium applies to these fixtures: hidden
// nodes drop out, display:contents and inline boxes join their parent's line, and every other
// box starts and ends a line. Chromium makes each child of a flex or grid container a block, and
// each run of text between those children too.
function installInnerText(window) {
  const render = (node, item = false) => {
    if (node.nodeType === window.Node.TEXT_NODE) return node.data.replace(/\s+/g, " ");
    if (node.nodeType !== window.Node.ELEMENT_NODE) return "";
    const style = window.getComputedStyle(node);
    if (node.hidden || style.display === "none" || style.visibility === "hidden") return "";
    const flex = /(?:flex|grid)$/.test(style.display);
    let inner = "";
    let run = "";
    for (const child of node.childNodes) {
      if (flex && child.nodeType === window.Node.TEXT_NODE) {
        run += render(child);
        continue;
      }
      if (run) inner += `\n${run}\n`;
      run = "";
      inner += render(child, flex);
    }
    if (run) inner += `\n${run}\n`;
    if (style.display === "contents" || (!item && style.display.startsWith("inline"))) {
      return inner;
    }
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

test("a lone result without a card wrapper stops at the end of the list", () => {
  const result = read(makeDom(fixture("flattened-single")));

  assert.deepEqual(result.rows, [
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

test("a link wrapping the whole card yields its name and metadata, even in two lines", () => {
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
    {
      name: "Riley Test",
      headline: "Baker at Example Bakery",
      location: "",
      profile_url: profile("riley-test-2"),
    },
  ]);
});

test("a name wrapped across lines without an aria-hidden name fails as unsupported", () => {
  const html = fixture("split-name").replace(
    /<span aria-hidden="true">([\s\S]*?<\/span>)<\/span><\/a>/,
    "$1</a>",
  );
  assert.notEqual(html, fixture("split-name"));

  const result = read(makeDom(html));

  assert.deepEqual(result, { rows: [], candidate_count: 1, resolved_count: 0, layout: "none" });
});

test("a card link whose photo and presence text render before the name yields that name", () => {
  const result = read(makeDom(fixture("card-link-presence")));

  assert.deepEqual(
    peopleSearchRows(result, { keywords: "example", limit: 5, searchUrl: SEARCH_URL }),
    [
      {
        rank: 1,
        name: "Morgan Sample",
        headline: "Pharmacist at Example Clinic",
        location: "Porto, Portugal",
        profile_url: profile("morgan-sample"),
      },
      {
        rank: 2,
        name: "Taylor Fixture",
        headline: "Librarian at Example Library",
        location: "",
        profile_url: profile("taylor-fixture"),
      },
    ],
  );
  assert.equal(result.candidate_count, 2);
});

test("rendered profile links without a readable name fail as unsupported, not as empty", () => {
  const html = fixture("card-link-presence").replace(
    /(<div><img alt=""><span>Status is \w+<\/span><\/div>)[\s\S]*?(<\/a>)/g,
    "$1$2",
  );

  const result = read(makeDom(html));

  assert.deepEqual(result, { rows: [], candidate_count: 2, resolved_count: 0, layout: "none" });
  assert.throws(
    () => peopleSearchRows(result, { keywords: "example", limit: 5, searchUrl: SEARCH_URL }),
    (error) => {
      assert.ok(error instanceof CommandExecutionError);
      assert.equal(error.code, "COMMAND_EXEC");
      assert.match(error.message, /layout is not supported/);
      return true;
    },
  );
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

test("mutual-connection links never stand in for results whose labels differ by ordinal", () => {
  const result = read(makeDom(fixture("lenient-mutual")));

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
      [profile("sacha-demo"), "Chef chez Exemple Bistro", "Lyon, Auvergne-Rhône-Alpes, France"],
    ],
  );
});

test("an unknown label no other result shares produces no rows, not the mutual links", () => {
  const html = fixture("lenient-mutual").replace("Relation de 1er niveau", "Vous");

  const result = read(makeDom(html));

  assert.deepEqual(result, { rows: [], candidate_count: 6, resolved_count: 0, layout: "none" });
});

test("block-level mutual-connection links are neither headlines nor results", () => {
  const result = read(makeDom(fixture("flex-social-proof")));

  assert.deepEqual(result.rows, [
    {
      name: "Avery Example",
      headline: "",
      location: "",
      profile_url: profile("avery-example"),
    },
    {
      name: "Blake Example",
      headline: "Product Manager at Example Labs",
      location: "Seattle, Washington, United States",
      profile_url: profile("blake-example"),
    },
  ]);
  assert.equal(result.candidate_count, 4);
});

test("block-level mutual-connection links never stand in for unknown-label results", () => {
  const html = fixture("lenient-mutual").replace(
    /<p>(<a href="https:\/\/www\.linkedin\.com\/in\/morgan-mutual-\d\/">[^<]+<\/a>) ([^<]+)<\/p>/g,
    '<p style="display: flex">$1<span>$2</span></p>',
  );
  assert.notEqual(html, fixture("lenient-mutual"));

  const result = read(makeDom(html));

  assert.equal(result.layout, "lenient");
  assert.deepEqual(
    result.rows.map((row) => row.profile_url),
    [profile("camille-exemple"), profile("dominique-test"), profile("sacha-demo")],
  );
});

test("a mutual-connection link whose sentence goes on in the next block is not a result", () => {
  const card = (handle, name, badge, headline) =>
    `<p><a href="/in/${handle}/"><span aria-hidden="true">${name}</span></a> • ${badge}</p>
    <p>${headline}</p>`;
  const pages = [
    // No card element, and the sentence's text is a sibling block.
    `<div role="list">
      ${card("avery-example", "Avery Example", "2nd", "Engineer at Example Co")}
      <div><a href="/in/morgan-mutual/">Morgan Mutual</a></div><div>is a mutual connection</div>
      ${card("blake-example", "Blake Example", "3rd+", "Designer at Example Co")}
    </div>`,
    // The sentence's text is a block inside the same paragraph.
    `<div role="list">
      ${card("avery-example", "Avery Example", "2nd", "Engineer at Example Co")}
      <p><a href="/in/morgan-mutual/">Morgan Mutual</a><span style="display: block">and 3 other mutual connections</span></p>
      ${card("blake-example", "Blake Example", "3rd+", "Designer at Example Co")}
    </div>`,
  ];

  for (const page of pages) {
    const result = read(makeDom(`<!doctype html><main>${page}</main>`));

    assert.deepEqual(
      result.rows.map((row) => [row.profile_url, row.headline]),
      [
        [profile("avery-example"), "Engineer at Example Co"],
        [profile("blake-example"), "Designer at Example Co"],
      ],
    );
  }
});

test("a later name in a result's card is not a result, even when no result carries a label", () => {
  const result = read(
    makeDom(`<!doctype html><main><ul>
      <li>
        <div><a href="/in/avery-example/"><span aria-hidden="true">Avery Example</span></a></div>
        <p>Engineer at Example Co</p>
        <div><a href="/in/morgan-mutual/">Morgan Mutual</a></div><div>also works at Example Co</div>
      </li>
      <li>
        <div><a href="/in/blake-example/"><span aria-hidden="true">Blake Example</span></a></div>
        <p>Designer at Example Co</p>
      </li>
    </ul></main>`),
  );

  assert.deepEqual(
    result.rows.map((row) => row.profile_url),
    [profile("avery-example"), profile("blake-example")],
  );
});

test("block-level name links without a degree badge keep their headlines", () => {
  const result = read(
    makeDom(`<!doctype html><main><ul>
      <li>
        <a style="display: block" href="/in/avery-example/"><span aria-hidden="true">Avery Example</span></a>
        <div>Engineer</div>
      </li>
      <li>
        <a style="display: block" href="/in/blake-example/"><span aria-hidden="true">Blake Example</span></a>
        <div>Designer</div>
      </li>
      <li>
        <div><a href="/in/casey-sample/"><span aria-hidden="true">Casey Sample</span></a></div>
        <div><a href="/in/morgan-mutual/">Morgan Mutual</a> and 3 other mutual connections</div>
      </li>
    </ul></main>`),
  );

  assert.deepEqual(
    result.rows.map((row) => [row.profile_url, row.headline]),
    [
      [profile("avery-example"), "Engineer"],
      [profile("blake-example"), "Designer"],
      [profile("casey-sample"), ""],
    ],
  );
});

test("mutual links in blocks of their own never stand in for unknown-label results", () => {
  const html = fixture("lenient-mutual")
    .replace(
      /<p>(<a href="https:\/\/www\.linkedin\.com\/in\/morgan-mutual-\d\/">[^<]+<\/a>) ([^<]+)<\/p>/g,
      "<div>$1</div><div>$2</div>",
    )
    .replace(/<\/?li>/g, "");
  assert.notEqual(html, fixture("lenient-mutual"));

  const result = read(makeDom(html));

  assert.equal(result.layout, "lenient");
  assert.deepEqual(
    result.rows.map((row) => row.profile_url),
    [profile("camille-exemple"), profile("dominique-test"), profile("sacha-demo")],
  );
});

test("without card elements, a link that ends its line is not a result when results carry labels", () => {
  const pages = [
    `<p><a href="/in/camille-exemple/"><span aria-hidden="true">Camille Exemple</span></a> • 1er</p>
    <p>Architecte chez Exemple SA</p>
    <div><a href="/in/morgan-mutuel/">Morgan Mutuel</a></div><div>et 3 autres relations en commun</div>
    <p><a href="/in/dominique-test/"><span aria-hidden="true">Dominique Test</span></a> • 2e</p>
    <p>Comptable chez Exemple Conseil</p>`,
    `<p><a href="/in/camille-exemple/"><span aria-hidden="true">Camille Exemple</span></a> • 2nd</p>
    <p>Engineer at Example Co</p>
    <div><a href="/in/morgan-mutuel/">Morgan Mutuel</a></div><div>also works at Example Co</div>
    <p><a href="/in/dominique-test/"><span aria-hidden="true">Dominique Test</span></a> • 3rd+</p>
    <p>Designer at Example Co</p>`,
  ];

  for (const page of pages) {
    const result = read(makeDom(`<!doctype html><main><div role="list">${page}</div></main>`));

    assert.deepEqual(
      result.rows.map((row) => row.profile_url),
      [profile("camille-exemple"), profile("dominique-test")],
    );
  }
});

test("labelled results drop a link that ends its line even when the first result's link spans two", () => {
  // Chromium puts an absolutely positioned span on a line of its own, so the first result's link
  // renders two lines and has no text after it.
  const result = read(
    makeDom(`<!doctype html><main><div role="list">
      <p><a href="/in/avery-example/"><span aria-hidden="true">Avery Example</span><span style="display: block">View Avery Example’s profile</span></a> • 2nd</p>
      <p>Engineer at Example Co</p>
      <div><a href="/in/morgan-mutual/">Morgan Mutual</a></div><div>also works at Example Co</div>
      <p><a href="/in/blake-example/"><span aria-hidden="true">Blake Example</span></a> • 3rd+</p>
      <p>Designer at Example Co</p>
    </div></main>`),
  );

  assert.deepEqual(
    result.rows.map((row) => [row.profile_url, row.headline]),
    [
      [profile("avery-example"), "Engineer at Example Co"],
      [profile("blake-example"), "Designer at Example Co"],
    ],
  );
});

test("a location that repeats a word of the name stays the location", () => {
  const result = read(
    makeDom(`<!doctype html><main><ul><li>
      <p><a href="/in/jack-london/"><span aria-hidden="true">Jack London</span></a> • 2nd</p>
      <p>Engineer</p>
      <p>London</p>
    </li></ul></main>`),
  );

  assert.deepEqual(result.rows, [
    {
      name: "Jack London",
      headline: "Engineer",
      location: "London",
      profile_url: profile("jack-london"),
    },
  ]);
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

test("a lone result with no card or list element reads no metadata past its link", () => {
  const result = read(
    makeDom(`<!doctype html><main><div><div>
      <a href="/in/casey-sample/"><span aria-hidden="true">Casey Sample</span></a>
      <div>Engineer</div>
    </div></div>
    <p>Are these results helpful?</p></main>`),
  );

  assert.deepEqual(result.rows, [
    { name: "Casey Sample", headline: "", location: "", profile_url: profile("casey-sample") },
  ]);
});

test("results bounded only by the main element leave the last one's metadata empty", () => {
  const result = read(
    makeDom(`<!doctype html><main>
      <p><a href="/in/sam-placeholder/"><span aria-hidden="true">Sam Placeholder</span></a> · 2nd</p>
      <p>Founder at Example Studio</p>
      <p>Denver, Colorado, United States</p>
      <p><a href="/in/casey-sample/"><span aria-hidden="true">Casey Sample</span></a> · 2nd</p>
      <p>Recruiter at Example Talent</p>
      <p>Are these results helpful?</p>
    </main>`),
  );

  assert.deepEqual(
    result.rows.map((row) => [row.name, row.headline, row.location]),
    [
      ["Sam Placeholder", "Founder at Example Studio", "Denver, Colorado, United States"],
      ["Casey Sample", "", ""],
    ],
  );
});

test("hidden profile links never become rows, whether the link or its card is hidden", () => {
  const result = read(
    makeDom(`<!doctype html><main><ul>
      <li>
        <a hidden href="/in/hidden-link/"><span aria-hidden="true">Hidden Link</span></a>
        <div>Should Not Appear</div>
      </li>
      <li>
        <a style="visibility: hidden" href="/in/invisible-link/"><span aria-hidden="true">Invisible Link</span></a>
        <div>Should Not Appear Either</div>
      </li>
      <li>
        <a href="/in/visible-person/"><span aria-hidden="true">Visible Person</span></a>
        <div>Analyst at Example Bank</div>
      </li>
    </ul></main>`),
  );

  assert.deepEqual(
    result.rows.map((row) => row.profile_url),
    [profile("visible-person")],
  );
  assert.equal(result.candidate_count, 1);
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
