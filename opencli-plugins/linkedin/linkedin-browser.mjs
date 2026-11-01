import { contactSectionsFromApi, unwrapEvaluateResult } from "./linkedin-helpers.mjs";

const CONTACT_LINK_SELECTOR = 'a[href*="/overlay/contact-info"]';
const CONTACT_PANEL_WAIT_MS = 8_000;
const CONTACT_SETTLE_MS = 2_000;
const CONTACT_API_TIMEOUT_MS = 8_000;
// Time an extraction round trip needs beyond its in-page waits, including the row settle.
const EXTRACTION_RESERVE_MS = 2_000 + CONTACT_SETTLE_MS;
// A profile-to-overlay navigation can spend 15s in the browser before its panel wait starts.
const NAVIGATION_RESERVE_MS = 15_000;

export function buildProfileProbeScript() {
  return String.raw`(function() {
    function clean(value) {
      return typeof value === 'string'
        ? value.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim()
        : '';
    }
    var bodyText = clean(document.body && document.body.innerText || '');
    var nameNode = document.querySelector('main h1')
      || document.querySelector('main section h2')
      || document.querySelector('h1');
    var unavailableMatch = bodyText.match(
      /profile (?:is )?not available|profile unavailable|member not found|profile not found|this page doesn(?:'|’)t exist|page not found|you don(?:'|’)t have access to this profile|this profile is private/i
    );
    var authText = [location.href || '', document.title || '', bodyText.slice(0, 4000)].join('\n');
    return {
      current_url: location.href || '',
      name: clean(nameNode && (nameNode.innerText || nameNode.textContent)),
      auth_wall: /linkedin\.com\/(?:login|checkpoint|authwall|uas)/i.test(authText)
        || /\b(?:sign in|log in|join linkedin|captcha|verification required)\b/i.test(authText)
        || /(请登录|登录领英|安全验证)/.test(authText),
      unavailable: Boolean(unavailableMatch),
      unavailable_reason: unavailableMatch ? clean(unavailableMatch[0]) : '',
    };
  })()`;
}

/**
 * Builds page JavaScript that reads the open Contact info section. It polls for up to `waitMs` for
 * a section to appear, then for up to `settleMs` more for its rows to render, and resolves the last
 * reading. An auth wall ends the polling at once. It never rejects on a missing section.
 */
export function buildContactExtractionScript({ waitMs = 0, settleMs = CONTACT_SETTLE_MS } = {}) {
  const waitBudget = Math.max(0, Math.floor(waitMs));
  const settleBudget = Math.max(0, Math.floor(settleMs));
  return String.raw`(function() {
    function clean(value) {
      return typeof value === 'string'
        ? value.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim()
        : '';
    }
    function unique(values) {
      var seen = {};
      return values.map(clean).filter(function(value) {
        var key = value.toLowerCase();
        if (!value || seen[key]) return false;
        seen[key] = true;
        return true;
      });
    }
    function headingOf(root) {
      var node = root.querySelector(':scope > div p, :scope > h3, :scope > h2')
        || root.querySelector('h3, h2, p');
      return clean(node && (node.innerText || node.textContent));
    }
    function sectionFromRoot(root, icon) {
      var heading = headingOf(root);
      var blocks = unique(Array.from(root.querySelectorAll('p, address')).map(function(node) {
        return node.innerText || node.textContent;
      })).filter(function(value) { return value.toLowerCase() !== heading.toLowerCase(); });
      var lines = unique(String(root.innerText || root.textContent || '').split(/\n+/))
        .filter(function(value) { return value.toLowerCase() !== heading.toLowerCase(); });
      var links = Array.from(root.querySelectorAll('a[href]')).map(function(link) {
        var context = link.closest('p, li, address');
        return {
          text: clean(link.innerText || link.textContent),
          href: link.href || link.getAttribute('href') || '',
          context: clean(context && (context.innerText || context.textContent)),
        };
      });
      return { heading: heading, icon: icon || '', blocks: blocks, lines: lines, links: links };
    }

    function extract() {
      var dialogs = Array.from(document.querySelectorAll('dialog, [role="dialog"]'));
      var dialog = dialogs.find(function(candidate) {
        var header = candidate.querySelector('header h1, header h2, h1, h2');
        return /^contact info$/i.test(clean(header && (header.innerText || header.textContent)));
      });
      var legacy = document.querySelector('section.pv-contact-info');
      var scope = dialog || legacy;
      var sections = [];
      if (scope) {
        Array.from(scope.querySelectorAll('[data-testid="lazy-column"]')).forEach(function(column) {
          Array.from(column.children).forEach(function(row) {
            var icon = Array.from(row.children).find(function(child) {
              return child.tagName && child.tagName.toLowerCase() === 'svg' && child.id;
            });
            if (!icon) return;
            var section = sectionFromRoot(row, icon.id);
            if (section.heading) sections.push(section);
          });
        });
        if (!sections.length) {
          Array.from(scope.querySelectorAll('section.pv-contact-info__contact-type')).forEach(function(row) {
            var section = sectionFromRoot(row, '');
            if (section.heading) sections.push(section);
          });
        }
      }

      var bodyText = clean(document.body && document.body.innerText || '');
      var dialogText = clean(scope && (scope.innerText || scope.textContent));
      var authText = [location.href || '', document.title || '', bodyText.slice(0, 4000)].join('\n');
      var restrictedText = [bodyText.slice(0, 6000), dialogText].join('\n');
      return {
        current_url: location.href || '',
        dialog_found: Boolean(scope),
        sections: sections,
        auth_wall: /linkedin\.com\/(?:login|checkpoint|authwall|uas)/i.test(authText)
          || /\b(?:sign in|log in|join linkedin|captcha|verification required)\b/i.test(authText)
          || /(请登录|登录领英|安全验证)/.test(authText),
        restricted: /contact info(?:rmation)? (?:is )?(?:private|unavailable|restricted)|not allowed to view|don(?:'|’)t have access/i.test(restrictedText),
      };
    }

    var waitMs = ${waitBudget};
    var settleMs = ${settleBudget};
    var first = extract();
    if (first.auth_wall
      || (first.dialog_found && first.sections.length > 0)
      || (!first.dialog_found && waitMs <= 0)) {
      return first;
    }
    var startedAt = Date.now();
    var foundAt = first.dialog_found ? startedAt : 0;
    return new Promise(function(resolve) {
      (function poll() {
        var payload = extract();
        var now = Date.now();
        if (payload.dialog_found && !foundAt) foundAt = now;
        if (payload.auth_wall
          || (payload.dialog_found && payload.sections.length > 0)
          || (foundAt && now - foundAt >= settleMs)
          || (!foundAt && now - startedAt >= waitMs)) {
          resolve(payload);
          return;
        }
        setTimeout(poll, 250);
      })();
    });
  })()`;
}

export async function extractProfileProbe(page) {
  return page.evaluate(buildProfileProbeScript());
}

export async function extractLinkedInContactInfo(page, options) {
  return page.evaluate(buildContactExtractionScript(options));
}

export async function waitForLinkedInPage(page) {
  try {
    await page.wait({ selector: "main, dialog[data-testid=dialog], [role=dialog]", timeout: 12 });
  } catch {
    await page.wait(3);
  }
}

/**
 * Builds page JavaScript that fetches LinkedIn's contact-info record for `publicId` with the page's
 * session. Resolves `{ ok: true, status, data }` on a 2xx JSON response and `{ ok: false, ... }` on
 * any other response, a missing csrf token, a network error, or `timeoutMs` passing. Never rejects.
 */
export function buildContactApiScript(publicId, timeoutMs = CONTACT_API_TIMEOUT_MS) {
  const path = `/voyager/api/identity/profiles/${encodeURIComponent(publicId)}/profileContactInfo`;
  const budget = Math.max(0, Math.floor(timeoutMs));
  return String.raw`(async function() {
    var cookie = (document.cookie || '').split('; ').find(function(entry) {
      return entry.indexOf('JSESSIONID=') === 0;
    }) || '';
    var csrf = cookie.slice('JSESSIONID='.length).replace(/^"|"$/g, '');
    if (!csrf) return { ok: false, reason: 'missing_csrf' };
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, ${budget});
    try {
      var response = await fetch(${JSON.stringify(path)}, {
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'csrf-token': csrf,
          'x-restli-protocol-version': '2.0.0',
        },
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, status: response.status };
      return { ok: true, status: response.status, data: await response.json() };
    } catch (error) {
      return { ok: false, reason: String(error && error.message || error) };
    } finally {
      clearTimeout(timer);
    }
  })()`;
}

function panelFound(payload) {
  const data = unwrapEvaluateResult(payload);
  return data?.dialog_found === true || data?.auth_wall === true;
}

/**
 * Reads the Contact info section for one profile page that is already loaded, returning the
 * extraction payload `normalizeContactPayload` accepts. It tries, in order: a section already on
 * the page, LinkedIn's contact-info record for `profile.identifier`, the profile's Contact info
 * link, and a direct navigation to `contactUrl`. Every step is skipped once `deadline` (epoch ms)
 * leaves too little time for it, so the call settles before OpenCLI's command timeout. When no
 * section opens, the payload has `dialog_found: false`, and `timed_out: true` if the deadline cut
 * the attempts short. A failed click falls through to navigation. Navigation and transport errors
 * propagate.
 */
export async function openLinkedInContactSection(
  page,
  contactUrl,
  { deadline = Date.now() + 45_000, profile = {}, now = Date.now } = {},
) {
  const remaining = () => deadline - now();
  const panelWait = () =>
    Math.max(0, Math.min(CONTACT_PANEL_WAIT_MS, remaining() - EXTRACTION_RESERVE_MS));

  let payload = await extractLinkedInContactInfo(page);
  if (panelFound(payload)) return payload;

  const publicId = profile.identifier;
  if (publicId && publicId !== "me" && remaining() > EXTRACTION_RESERVE_MS) {
    const timeoutMs = Math.min(CONTACT_API_TIMEOUT_MS, remaining() - EXTRACTION_RESERVE_MS);
    const api = unwrapEvaluateResult(
      await page.evaluate(buildContactApiScript(publicId, timeoutMs)),
    );
    const sections =
      api?.ok === true ? contactSectionsFromApi(api.data, profile.profile_url) : null;
    if (sections) return { dialog_found: true, sections };
  }

  const link = unwrapEvaluateResult(await page.evaluate(buildContactLinkScript()));
  if (link?.count > 0 && panelWait() > 0) {
    let clicked = false;
    try {
      await page.click(CONTACT_LINK_SELECTOR, link.count > 1 ? { nth: link.index } : undefined);
      clicked = true;
    } catch {}
    if (clicked) {
      payload = await extractLinkedInContactInfo(page, { waitMs: panelWait() });
      if (panelFound(payload)) return payload;
    }
  }

  if (remaining() < NAVIGATION_RESERVE_MS + EXTRACTION_RESERVE_MS) {
    return { ...unwrapEvaluateResult(payload), timed_out: true };
  }
  await page.goto(contactUrl);
  const waitMs = panelWait();
  payload = await extractLinkedInContactInfo(page, { waitMs });
  const data = unwrapEvaluateResult(payload);
  if (data && typeof data === "object" && !panelFound(data) && waitMs < CONTACT_PANEL_WAIT_MS) {
    return { ...data, timed_out: true };
  }
  return payload;
}

function buildContactLinkScript() {
  return String.raw`(function() {
    var links = Array.from(document.querySelectorAll(${JSON.stringify(CONTACT_LINK_SELECTOR)}));
    var index = links.findIndex(function(link) {
      var rect = link.getBoundingClientRect();
      var style = getComputedStyle(link);
      return rect.width > 0 && rect.height > 0
        && style.visibility !== 'hidden' && style.display !== 'none';
    });
    return { count: links.length, index: index < 0 ? 0 : index };
  })()`;
}
