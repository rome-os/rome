/**
 * Reads people-search result rows from the rendered LinkedIn page. Runs inside the page, so it is
 * self-contained and serialized with toString().
 *
 * Returns `{ rows, candidate_count, resolved_count, layout }`, or `{ error, url }` off the search
 * page. Each row's headline and location come only from the text between its own result's first
 * profile link and the next result's, so a row never carries another result's metadata. A field
 * stays empty when that span has no line for it.
 */
export function readPeopleSearchPage() {
  const href = String(location.href || "");
  if (!/search\/results\/people/.test(href)) {
    return { error: "not on people search page", url: href };
  }
  const main = document.querySelector("main") || document.body;
  const clean = (value) =>
    String(value ?? "")
      .replace(/[\s\u00a0\u202f]+/g, " ")
      .trim();
  const action = (line) =>
    /^(?:Message|Connect|Follow|Following|View profile|Pending|Remove|Withdraw)$/i.test(line);
  const skip = (line) =>
    !line ||
    /^Status is\b/i.test(line) ||
    action(line) ||
    /^[•·∙]/.test(line) ||
    /^(?:1st|2nd|3rd\+?)(?:\s+degree(?:\s+connection)?)?$/i.test(line) ||
    /\b(?:mutual|shared) connections?\b/i.test(line) ||
    /^(?:Summary|Current|Past|Skills):/i.test(line) ||
    /^About this profile/i.test(line) ||
    /^View .+['’]s profile$/i.test(line);
  // What may follow a name on its rendered line: a degree badge, a bullet, or pronouns.
  // Anything else means the link sits inside a sentence, like a mutual-connection line.
  const badge = (text) =>
    !text ||
    /^[•·∙]/.test(text) ||
    /^(?:1st|2nd|3rd\+?|\d\S{0,3})(?:\s+degree(?:\s+connection)?)?$/i.test(text) ||
    /^\([^()]{1,30}\)(?:\s*[•·∙].*)?$/.test(text);
  const collapseRepeatedName = (name) => {
    const parts = name.split(" ").filter(Boolean);
    if (parts.length === 0 || parts.length % 2 !== 0) return name;
    const half = parts.length / 2;
    for (let i = 0; i < half; i++) if (parts[i] !== parts[i + half]) return name;
    return parts.slice(0, half).join(" ");
  };
  const cleanName = (value) => {
    let name = clean(value).replace(/^Status is \S+\.?\s*/i, "");
    const view = name.match(/^View (.+?)['’]s profile$/i);
    if (view) name = view[1];
    name = name
      .replace(/['’]s profile(?: picture)?$/i, "")
      .replace(/\s*[•·∙].*$/, "")
      .trim();
    name = collapseRepeatedName(name);
    return skip(name) ? "" : name;
  };
  const tokens = (text) => clean(text).toLowerCase().split(" ").filter(Boolean);
  const handleOf = (anchor) => {
    try {
      const url = new URL(anchor.getAttribute("href") || "", location.href);
      const host = url.hostname.toLowerCase();
      if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return "";
      const match = url.pathname.match(/^\/in\/([^/?#]+)/);
      return match ? match[1] : "";
    } catch {
      return "";
    }
  };

  const anchors = Array.from(main.querySelectorAll('a[href*="/in/"]'))
    .map((el) => ({ el, handle: handleOf(el) }))
    .filter((anchor) => anchor.handle);

  // LinkedIn rotates class names and wraps cards in display:contents nodes, so neither
  // selectors nor ancestor walks find a stable card element. Instead, text markers go in
  // before and after every profile link, main.innerText is read once, and the markers are
  // removed in the same task. innerText keeps document order and drops hidden nodes, so each
  // marker pins a link to its rendered position without matching names against the text. The
  // page never paints the markers, because nothing yields to the event loop before removal.
  const MARK = "\u2063";
  const nonce = String(Math.floor(Math.random() * 1e9));
  const markerPattern = new RegExp(`${MARK}${nonce}:(\\d+|end):([se])${MARK}`, "gi");
  const readMarked = (endContainer) => {
    const inserted = [];
    const insert = (parent, before, id, kind) => {
      const node = document.createTextNode(`${MARK}${nonce}:${id}:${kind}${MARK}`);
      parent.insertBefore(node, before);
      inserted.push(node);
    };
    let text = "";
    try {
      anchors.forEach(({ el }, index) => {
        if (!el.parentNode) return;
        insert(el.parentNode, el, index, "s");
        insert(el.parentNode, el.nextSibling, index, "e");
      });
      if (endContainer) insert(endContainer, null, "end", "e");
      text = String(main.innerText || "");
    } finally {
      for (const node of inserted) node.parentNode?.removeChild(node);
    }
    const lines = [];
    const marks = new Map();
    text.split("\n").forEach((raw, line) => {
      let out = "";
      let last = 0;
      markerPattern.lastIndex = 0;
      for (let match = markerPattern.exec(raw); match; match = markerPattern.exec(raw)) {
        out += raw.slice(last, match.index);
        const key = `${match[1]}:${match[2].toLowerCase()}`;
        if (!marks.has(key)) marks.set(key, { line, col: out.length });
        last = markerPattern.lastIndex;
      }
      lines.push(out + raw.slice(last));
    });
    return { lines, marks };
  };
  const chunks = (lines, from, to) => {
    const out = [];
    for (let line = from.line; line < lines.length && (!to || line <= to.line); line++) {
      const start = line === from.line ? from.col : 0;
      const end = to && line === to.line ? to.col : lines[line].length;
      out.push({ line, start, end, text: lines[line].slice(start, end) });
    }
    return out;
  };

  const first = readMarked(null);
  const startsByLine = new Map();
  const views = anchors.map((anchor, index) => {
    const start = first.marks.get(`${index}:s`);
    const end = first.marks.get(`${index}:e`);
    if (!start || !end) return { ...anchor, index, rendered: false, name: "" };
    if (!startsByLine.has(start.line)) startsByLine.set(start.line, []);
    startsByLine.get(start.line).push({ col: start.col, handle: anchor.handle });
    const own = chunks(first.lines, start, end)
      .map((chunk) => clean(chunk.text))
      .filter(Boolean);
    const aria = anchor.el.querySelector('span[aria-hidden="true"]');
    return {
      ...anchor,
      index,
      rendered: true,
      own,
      name: cleanName(aria?.textContent) || cleanName(own[0]),
      before: clean(first.lines[start.line].slice(0, start.col)),
      // A link spanning several lines ends its first line itself, so only a one-line link
      // can share its name's line with trailing text.
      after: own.length > 1 ? "" : clean(first.lines[end.line].slice(end.col)),
      endLine: end.line,
    };
  });
  const candidateHandles = new Set(views.filter((view) => view.name).map((view) => view.handle));

  // Text before a name on its line can only be presence status, which skip() covers.
  const standalone = (view) => view.rendered && view.name && skip(view.before);
  const unique = (list) => {
    const seen = new Set();
    return list.filter((view) => {
      if (seen.has(view.handle)) return false;
      seen.add(view.handle);
      return true;
    });
  };
  let layout = "strict";
  let primaries = unique(
    views.filter((view) => standalone(view) && (badge(view.after) || action(view.after))),
  );
  if (primaries.length === 0) {
    // Unknown trailing labels, such as a degree badge in another language. Results share one
    // card template, so their names share the shape of the trailing text, digits aside. A
    // sentence such as a mutual-connection line has its own shape, and when it ties with the
    // results the earlier group wins, because a result's name precedes its card's other lines.
    const groups = new Map();
    for (const view of views) {
      const foreign = (startsByLine.get(view.endLine) || []).some(
        (start) => start.handle !== view.handle,
      );
      if (!standalone(view) || foreign) continue;
      const shape = view.after.toLowerCase().replace(/\d+/g, "#");
      if (!groups.has(shape)) groups.set(shape, []);
      groups.get(shape).push(view);
    }
    let best = [];
    for (const group of groups.values()) {
      const members = unique(group);
      if (members.length > best.length) best = members;
    }
    layout = "lenient";
    primaries = best.length > 1 || candidateHandles.size === 1 ? best : [];
  }
  if (primaries.length === 0) {
    return {
      rows: [],
      candidate_count: candidateHandles.size,
      resolved_count: 0,
      layout: "none",
    };
  }

  // A result's span starts at its first profile link, usually the photo just before the name.
  const starts = primaries.map((primary, k) => {
    const floor = k > 0 ? primaries[k - 1].index : -1;
    let start = primary.index;
    while (
      start - 1 > floor &&
      views[start - 1].handle === primary.handle &&
      views[start - 1].rendered
    ) {
      start--;
    }
    return start;
  });

  // The last span ends with the results list, not the page, so pagination and footer text never
  // become its metadata. The list is the deepest node holding every result's name link.
  let endContainer = null;
  if (primaries.length > 1) {
    const ancestors = (node) => {
      const chain = [];
      for (let at = node.parentNode; at && at !== main.parentNode; at = at.parentNode) {
        chain.push(at);
      }
      return chain;
    };
    const shared = ancestors(primaries[0].el);
    endContainer =
      shared.find((node) => primaries.every((primary) => node.contains(primary.el))) || null;
  } else {
    endContainer = primaries[0].el.closest('li, [role="listitem"], article');
  }
  const second = readMarked(endContainer);
  const listEnd = second.marks.get("end:e") || null;
  const linkStarts = new Map();
  views.forEach((view) => {
    const start = second.marks.get(`${view.index}:s`);
    if (!start) return;
    if (!linkStarts.has(start.line)) linkStarts.set(start.line, []);
    linkStarts.get(start.line).push({ col: start.col, handle: view.handle });
  });

  const rows = primaries.map((primary, k) => {
    const nameTokens = new Set(tokens(primary.name));
    const namePart = (line) => {
      const parts = tokens(line.replace(/\s*[•·∙].*$/, ""));
      return parts.length > 0 && parts.every((part) => nameTokens.has(part));
    };
    const metadata = (line) => !skip(line) && !badge(line) && !namePart(line);
    // A link that renders three or more lines wraps the whole card, so its own lines after the
    // name are metadata. A shorter link holds only the name, possibly wrapped across two lines.
    const found = primary.own.length >= 3 ? primary.own.filter(metadata) : [];
    const nameEnd = second.marks.get(`${primary.index}:e`);
    const next = k + 1 < primaries.length ? second.marks.get(`${starts[k + 1]}:s`) : listEnd;
    if (nameEnd) {
      for (const chunk of chunks(second.lines, nameEnd, next)) {
        // The rest of the name's own line holds badges, never the headline.
        if (chunk.line === nameEnd.line) continue;
        // A line holding another member's link is social proof such as mutual connections.
        // Headline and location come before it, so reading stops there.
        const foreign = (linkStarts.get(chunk.line) || []).some(
          (start) =>
            start.handle !== primary.handle && start.col >= chunk.start && start.col < chunk.end,
        );
        if (foreign) break;
        const line = clean(chunk.text);
        if (metadata(line)) found.push(line);
      }
    }
    return {
      name: primary.name,
      headline: found[0] || "",
      location: found[1] || "",
      profile_url: `https://www.linkedin.com/in/${primary.handle}/`,
    };
  });
  return {
    rows,
    candidate_count: candidateHandles.size,
    resolved_count: rows.length,
    layout,
  };
}
