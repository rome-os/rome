import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { FLIGHT_PRICE_PATTERN_SOURCE } from "./flight-labels.mjs";
import { createRequire } from "node:module";
import test from "node:test";
import {
  configureFlightAirports,
  flightAirportPicker,
  parseFlightLocation,
  verifyFlightAirports,
} from "./flight-airports.mjs";

const { JSDOM } = createRequire(new URL("../../packages/web/package.json", import.meta.url))(
  "jsdom",
);

for (const value of [
  "SFO",
  "sfo",
  "San Francisco",
  "San Francisco International Airport",
  "Paris, France",
  "New York, USA",
]) {
  test(`preserves single-location input: ${value}`, () => {
    assert.deepEqual(parseFlightLocation(` ${value} `, "from"), { query: value, airports: null });
  });
}

test("normalizes lists, deduplicates codes, and seeds only the first airport", () => {
  assert.deepEqual(parseFlightLocation(" sfo, OAK,sfo ", "from"), {
    query: "SFO",
    airports: ["SFO", "OAK"],
  });
  assert.deepEqual(parseFlightLocation("iah,HOU", "to"), {
    query: "IAH",
    airports: ["IAH", "HOU"],
  });
  assert.deepEqual(parseFlightLocation("sfo,SFO", "from"), { query: "SFO", airports: ["SFO"] });
});

for (const value of [
  "",
  " ",
  "SFO,",
  ",SFO",
  "SFO,,OAK",
  "SFO,Oakland",
  "SFO,O4K",
  "SFO,<script>",
  "SFO,OAK,SJC,LAX,JFK,EWR,LGA,BOS",
]) {
  test(`rejects an empty location or malformed airport list: ${value}`, () => {
    assert.throws(() => parseFlightLocation(value, "to"), /to /);
  });
}

test("allows seven distinct airports after deduplication", () => {
  assert.equal(parseFlightLocation("SFO,OAK,SJC,LAX,JFK,EWR,LGA,SFO", "from").airports.length, 7);
});

// Minimal DOM from the live picker contract: chip divs, exact data-code/data-type suggestions,
// and checkbox roles after multi-select hydrates (option roles during the transition).
function browser({
  role = "checkbox",
  missing,
  extra = [],
  drop,
  selectionDelay = 2,
  suggestionDelay = 2,
} = {}) {
  const dom = new JSDOM('<html lang="en"><body></body></html>', { runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLElement.prototype.getClientRects = function () {
    for (let element = this; element; element = element.parentElement) {
      if (element.hidden || window.getComputedStyle(element).display === "none") return [];
    }
    return [{}];
  };
  const calls = [];
  let tick = 0;
  const pending = [];
  const later = (delay, fn) => pending.push({ time: tick + delay, fn });
  for (const [side, initial] of [
    ["origin", "SFO"],
    ["destination", "IAH"],
  ]) {
    const label = side === "origin" ? "Where from?" : "Where to?";
    const title = side === "origin" ? "Origin" : "Destination";
    const root = window.document.createElement("section");
    root.innerHTML = `<input aria-label="${label} Test ${initial}">
      <div role="dialog" aria-label="Enter your ${side}" hidden>
        <div class="chips" role="listbox"></div><input role="combobox" aria-label="Where else?">
        <button aria-label="${title}, Select multiple airports"></button>
        <button aria-label="Done" hidden></button><ul class="suggestions"></ul>
      </div>`;
    window.document.body.append(root);
    const dialog = root.querySelector('[role="dialog"]');
    const chips = dialog.querySelector(".chips");
    const addChip = (code) => {
      const chip = window.document.createElement("div");
      chip.dataset.code = code;
      chip.innerHTML = `<div role="option">${code}</div><div role="button" aria-label="Remove"></div>`;
      chip.querySelector('[aria-label="Remove"]').onclick = () => chip.remove();
      chips.append(chip);
    };
    for (const code of [initial, ...(side === "origin" ? extra : [])]) addChip(code);
    root.querySelector("input").onclick = () => {
      dialog.hidden = false;
    };
    const multiple = dialog.querySelector("button");
    const done = dialog.querySelector('[aria-label="Done"]');
    multiple.onclick = () => {
      multiple.hidden = true;
      done.hidden = false;
    };
    done.onclick = () => {
      calls.push(["done", side]);
      const url = new window.URL(window.location.href);
      url.searchParams.set(side, [...chips.children].map((chip) => chip.dataset.code).join(","));
      window.history.replaceState(null, "", url);
      dialog.hidden = true;
    };
    dialog.querySelector("input").oninput = (event) => {
      const code = event.target.value;
      calls.push(["type", side, code]);
      const suggestions = dialog.querySelector(".suggestions");
      suggestions.innerHTML = "";
      later(suggestionDelay, () => {
        // A city and a hidden airport with the same code must not be selected.
        suggestions.innerHTML = `<li role="${role}" data-type="3" data-code="${code}">City</li>
          <li role="${role}" data-type="1" data-code="${code}" hidden>Hidden airport</li>`;
        for (const bad of suggestions.children)
          bad.onclick = () => {
            throw new Error("selected a city or hidden option");
          };
        if (missing === code) return;
        const option = window.document.createElement("li");
        option.setAttribute("role", role);
        option.dataset.type = "1";
        option.dataset.code = code;
        option.onclick = () => {
          calls.push(["select", side, code]);
          if (drop !== code) later(selectionDelay, () => addChip(code));
        };
        suggestions.append(option);
      });
    };
  }
  const page = {
    async evaluate(script) {
      return JSON.parse(JSON.stringify(window.eval(script)));
    },
    async wait() {
      tick++;
      const ready = pending.filter((job) => job.time <= tick);
      for (const job of ready) {
        pending.splice(pending.indexOf(job), 1);
        job.fn();
      }
    },
  };
  return { dom, page, calls, close: () => dom.window.close() };
}

for (const role of ["checkbox", "option"]) {
  test(`configures both lists with delayed ${role} suggestions and verifies the closed pickers`, async () => {
    const b = browser({ role, extra: ["SJC"] });
    try {
      const selections = { origin: ["SFO", "OAK"], destination: ["IAH", "HOU"] };
      await configureFlightAirports(b.page, selections);
      await verifyFlightAirports(b.page, selections);
      assert.deepEqual(b.calls, [
        ["type", "origin", "OAK"],
        ["select", "origin", "OAK"],
        ["done", "origin"],
        ["type", "destination", "HOU"],
        ["select", "destination", "HOU"],
        ["done", "destination"],
      ]);
      assert.equal(b.dom.window.document.querySelector('[data-code="SJC"]'), null);
    } finally {
      b.close();
    }
  });
}

for (const side of ["origin", "destination"]) {
  test(`supports a list on only the ${side} side`, async () => {
    const b = browser();
    try {
      const selections = {
        origin: null,
        destination: null,
        [side]: side === "origin" ? ["SFO", "OAK"] : ["IAH", "HOU"],
      };
      await configureFlightAirports(b.page, selections);
      await verifyFlightAirports(b.page, selections);
      assert.ok(b.calls.every((call) => call[1] === side));
    } finally {
      b.close();
    }
  });
}

test("single-location searches do not touch the airport UI", async () => {
  const page = {
    evaluate() {
      throw new Error("unexpected browser call");
    },
  };
  await configureFlightAirports(page, { origin: null, destination: null });
  await verifyFlightAirports(page, { origin: null, destination: null });
});

for (const options of [{ missing: "OAK" }, { drop: "OAK" }]) {
  test(`fails closed when an airport cannot be selected: ${JSON.stringify(options)}`, async () => {
    const b = browser(options);
    try {
      await assert.rejects(
        configureFlightAirports(b.page, { origin: ["SFO", "OAK"] }),
        /origin airports: SFO,OAK/,
      );
      assert.equal(b.calls.filter((call) => call[0] === "done").length, 0);
    } finally {
      b.close();
    }
  });
}

test("rejects a narrowed, expanded, or missing committed selection", async () => {
  const b = browser();
  try {
    await assert.rejects(
      verifyFlightAirports(b.page, { origin: ["SFO", "OAK"] }),
      /did not retain/,
    );
    await assert.rejects(verifyFlightAirports(b.page, { origin: [] }), /did not retain/);
    b.dom.window.document.querySelector('[aria-label="Enter your origin"]').remove();
    await assert.rejects(verifyFlightAirports(b.page, { origin: ["SFO"] }), /did not retain/);
  } finally {
    b.close();
  }
});

test("missing picker controls time out instead of returning partial-route results", async () => {
  const b = browser();
  try {
    b.dom.window.document.body.innerHTML = "Consent required";
    await assert.rejects(
      configureFlightAirports(b.page, { origin: ["SFO", "OAK"] }),
      /Could not configure/,
    );
  } finally {
    b.close();
  }
});

test("picker helpers serialize without module closures", () => {
  const b = browser();
  try {
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          b.dom.window.eval(`(${flightAirportPicker})({side:'origin',action:'read'})`),
        ),
      ),
      ["SFO"],
    );
  } finally {
    b.close();
  }
});

function commandFixture(options = {}) {
  const b = browser(options);
  let command;
  const source = readFileSync(new URL("./flights.js", import.meta.url), "utf8").replace(
    /^import[\s\S]*?from "[^"]+";\n/gm,
    "",
  );
  vm.runInNewContext(source, {
    cli: (definition) => {
      command = definition;
    },
    Strategy: { PUBLIC: "public" },
    CommandExecutionError: Error,
    FLIGHT_PRICE_PATTERN_SOURCE,
    configureFlightAirports,
    parseFlightLocation,
    verifyFlightAirports,
    URL,
  });
  const defaults = Object.fromEntries(
    command.args.filter((arg) => arg.default !== undefined).map((arg) => [arg.name, arg.default]),
  );
  const navigations = [];
  const extractions = [];
  const page = {
    ...b.page,
    async goto(url) {
      navigations.push(url);
      b.dom.reconfigure({ url });
      if (options.narrowOnReload && navigations.length > 1) {
        b.dom.window.document.querySelector('.chips [data-code="OAK"]')?.remove();
      }
    },
    async evaluate(script) {
      if (script.includes("var cards =")) {
        extractions.push({ script, navigations: [...navigations] });
        return { available: 1, items: [{ leg_route: "OAK–HOU" }] };
      }
      return b.page.evaluate(script);
    },
  };
  return {
    ...b,
    navigations,
    extractions,
    run: (args) => command.func(page, { ...defaults, depart: "2026-10-15", ...args }),
  };
}

for (const returnDate of [undefined, "2026-10-20"]) {
  test(`command reloads the combined route before extraction (${returnDate ? "round trip" : "one way"})`, async () => {
    const b = commandFixture();
    try {
      await b.run({ from: "sfo,OAK", to: "iah,HOU", return: returnDate });
      assert.equal(b.navigations.length, 2);
      const query = new URL(b.navigations[0]).searchParams.get("q");
      assert.ok(query.includes("from SFO to IAH"));
      assert.ok(!query.includes(","));
      assert.equal(query.includes("through 2026-10-20"), Boolean(returnDate));
      const committed = new URL(b.navigations[1]);
      assert.equal(committed.searchParams.get("origin"), "SFO,OAK");
      assert.equal(committed.searchParams.get("destination"), "IAH,HOU");
      assert.equal(b.extractions.length, 1);
      assert.equal(b.extractions[0].navigations.length, 2);
      assert.ok(b.extractions[0].script.includes(`"roundTrip":${Boolean(returnDate)}`));
    } finally {
      b.close();
    }
  });
}

test("command fails before extracting when Google narrows the committed route", async () => {
  const b = commandFixture({ narrowOnReload: true });
  try {
    await assert.rejects(b.run({ from: "SFO,OAK", to: "IAH,HOU" }), /did not retain/);
    assert.equal(b.extractions.length, 0);
  } finally {
    b.close();
  }
});

test("command rejects malformed lists before navigation", async () => {
  const b = commandFixture();
  try {
    await assert.rejects(b.run({ from: "SFO,,OAK", to: "IAH" }), /comma-separated/);
    assert.equal(b.navigations.length, 0);
  } finally {
    b.close();
  }
});

test("single-location command keeps its natural-language URL and avoids the picker", async () => {
  const b = commandFixture();
  try {
    await b.run({ from: "Paris, France", to: "Tokyo" });
    assert.equal(b.navigations.length, 1);
    assert.ok(
      new URL(b.navigations[0]).searchParams.get("q").includes("from Paris, France to Tokyo"),
    );
    assert.equal(b.calls.length, 0);
  } finally {
    b.close();
  }
});
