// Fictional LinkedIn profile pages for the connect tests. The markup keeps only what the probe
// reads: the owner name, degree badges, action controls, and member links.
import { createRequire } from "node:module";

// The web test workspace owns jsdom. The LinkedIn plugin has no runtime dependencies.
const { JSDOM, VirtualConsole } = createRequire(
  new URL("../../packages/web/package.json", import.meta.url),
)("jsdom");

export const OWNER_URL = "https://www.linkedin.com/in/jane-doe/";
export const OWNER_NAME = "Jane Doe";

const peopleYouMayKnow = `
  <section class="k3m9">
    <h2>People you may know</h2>
    <ul>
      <li>
        <a href="/in/alex-example/">Alex Example</a>
        <span>· 2nd</span>
        <a href="/preload/custom-invite/?vanityName=alex-example"
           aria-label="Invite Alex Example to connect">Connect</a>
      </li>
      <li>
        <a href="/in/sam-sample/">Sam Sample</a>
        <button>Connect</button>
      </li>
    </ul>
  </section>`;

/**
 * #1542: a first-degree connection on the hashed-class layout. The name is an h2, no container
 * carries a top-card class, and no owner action names the owner.
 */
export const connectedHashedLayout = (badge = "<span>· 1st</span>") => `
  <main>
    <section class="p7q2">
      <div class="h4x1"><h2 class="n8v3">Jane Doe</h2>${badge}</div>
      <p>Product Designer at Example Co</p>
      <div class="b6t0">
        <a href="/messaging/compose/?recipient=jane-doe">Message</a>
        <button aria-label="More actions">More</button>
      </div>
    </section>
    ${peopleYouMayKnow}
  </main>`;

/** #1542 as the triage reduced it: the name is only in the title and no header exists. */
export const connectedWithoutHeader = `
  <main>
    <div><span>1st degree connection</span></div>
    <div>
      <a href="/in/alex-example/">Alex Example</a>
      <a href="/preload/custom-invite/?vanityName=alex-example">Connect</a>
    </div>
  </main>`;

/**
 * #1491: Follow is the primary action and Connect sits in the More menu. The first element
 * with a top-card class is the photo wrapper, which holds no actions.
 */
export const followPrimaryLayout = (menuAttributes = "") => `
  <main>
    <section class="artdeco-card r2d7">
      <div class="pv-top-card__non-self-photo-wrapper"><img alt="Jane Doe"></div>
      <div class="ph5">
        <h1 class="text-heading-xlarge">Jane Doe</h1>
        <span class="dist-value">· 3rd+</span>
        <div class="w1e5">
          <button aria-label="Follow">Follow</button>
          <button aria-label="More actions" aria-expanded="false" ${menuAttributes}>More</button>
        </div>
      </div>
    </section>
    <aside>
      <h2>More profiles for you</h2>
      <a href="/in/alex-example/">Alex Example</a>
      <a href="/preload/custom-invite/?vanityName=alex-example">Connect</a>
      <button>More</button>
    </aside>
  </main>`;

/** A second-degree open profile that offers Message next to the owner's own Connect. */
export const messageAndConnectLayout = `
  <main>
    <section class="pv-top-card">
      <h1>Jane Doe</h1>
      <span class="dist-value">2nd</span>
      <span class="visually-hidden">2nd degree connection</span>
      <div class="pvs-profile-actions">
        <button aria-label="Invite Jane Doe to connect">Connect</button>
        <a href="/messaging/compose/?recipient=jane-doe">Message</a>
        <button aria-label="More actions">More</button>
      </div>
    </section>
    ${peopleYouMayKnow}
  </main>`;

/** A profile whose Connect is an invitation-route link, beside a sidebar link for someone else. */
export const connectLinkLayout = `
  <main>
    <section class="pv-top-card">
      <h1>Jane Doe</h1>
      <div class="pvs-profile-actions">
        <a href="/preload/custom-invite/?vanityName=jane-doe"
           aria-label="Invite Jane Doe to connect">Connect</a>
        <button aria-label="More actions">More</button>
      </div>
    </section>
    ${peopleYouMayKnow}
  </main>`;

/** A header that nests another member's recommendation card inside its own section. */
export const nestedRecommendationLayout = (badge) => `
  <main>
    <section class="u5j2">
      <div class="h4x1"><h2>Jane Doe</h2>${badge}</div>
      <div class="b6t0">
        <button aria-label="Follow Jane Doe">Follow</button>
        <button aria-label="More actions">More</button>
      </div>
      <div class="c1o8">
        <a href="/in/alex-example/">Alex Example</a>
        <span>· 1st</span>
        <button>Connect</button>
        <button aria-label="Invite Sam Sample to connect">Connect</button>
      </div>
    </section>
  </main>`;

/**
 * A namesake's recommendation card that precedes the owner's header in main. The namesake links
 * to another vanity and offers Connect, while the owner is already a first-degree connection.
 */
export const namesakeBeforeHeader = (ownerName = "<h1>Jane Doe</h1>") => `
  <main>
    <section class="pymk">
      <a href="/in/jane-doe-2/"><span>Jane Doe</span></a>
      <span>· 2nd</span>
      <button>Connect</button>
    </section>
    <section class="p7q2">
      <div class="h4x1">${ownerName}<span>· 1st</span></div>
      <div class="b6t0">
        <a href="/messaging/compose/?recipient=jane-doe">Message</a>
      </div>
    </section>
  </main>`;

/**
 * A Follow-primary header whose action row also holds `actions`, such as a Connect control that
 * belongs to another member or a Connect link to a route other than the owner's invitation.
 */
export const followPrimaryWithActions = (actions) => `
  <main>
    <section class="pv-top-card">
      <h1>Jane Doe</h1>
      <span class="dist-value">· 3rd+</span>
      <div class="pvs-profile-actions">
        <button aria-label="Follow Jane Doe">Follow</button>
        ${actions}
        <button aria-label="More actions" aria-expanded="false">More</button>
      </div>
    </section>
  </main>`;

export const headerWithoutActions = `
  <main><section class="pv-top-card"><h1>Jane Doe</h1></section>${peopleYouMayKnow}</main>`;

export const followOnlyLayout = `
  <main>
    <section class="pv-top-card">
      <h1>Jane Doe</h1>
      <button aria-label="Follow Jane Doe">Follow</button>
    </section>
    ${peopleYouMayKnow}
  </main>`;

function labelOf(el) {
  return (el.textContent || el.getAttribute?.("aria-label") || "").replace(/\s+/g, " ").trim();
}

/**
 * Builds a jsdom profile page. `clicks` records the label of every click and `clickTimes` its
 * time, and no click reaches a default action, so a link never navigates. With `menuItems`, the More control toggles a menu portaled to the body:
 * `menuMode: "escape"` also closes it on Escape, and `"toggle"` closes it only on a second click.
 * With `menuItemsDelayMs`, the menu opens empty and its items render after that delay. A function
 * `menuItems` is called with the 1-based count of opens and returns that open's items.
 */
export function profileDom(
  body,
  {
    url = OWNER_URL,
    title = `${OWNER_NAME} | LinkedIn`,
    menuItems = null,
    menuMode = "escape",
    menuItemsDelayMs = 0,
  } = {},
) {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
    { url, runScripts: "outside-only", virtualConsole: new VirtualConsole() },
  );
  const w = dom.window;
  Object.defineProperty(w.HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      for (let el = this; el; el = el.parentElement) {
        if (el.hidden || w.getComputedStyle(el).display === "none") return null;
      }
      return w.document.body;
    },
  });
  const clicks = [];
  const clickTimes = [];
  w.document.addEventListener(
    "click",
    (event) => {
      event.preventDefault();
      clicks.push(labelOf(event.target));
      clickTimes.push(Date.now());
    },
    true,
  );

  if (menuItems !== null) {
    const more = Array.from(w.document.querySelectorAll("main section button")).find(
      (el) => labelOf(el) === "More",
    );
    let menu = null;
    let opens = 0;
    const closeMenu = () => {
      menu?.remove();
      menu = null;
      more.setAttribute("aria-expanded", "false");
    };
    more.addEventListener("click", () => {
      if (menu) return closeMenu();
      opens += 1;
      const items = typeof menuItems === "function" ? menuItems(opens) : menuItems;
      menu = w.document.createElement("div");
      menu.setAttribute("role", "menu");
      w.document.body.append(menu);
      if (menuItemsDelayMs > 0) {
        const opened = menu;
        w.setTimeout(() => {
          opened.innerHTML = items;
        }, menuItemsDelayMs);
      } else {
        menu.innerHTML = items;
      }
      more.setAttribute("aria-expanded", "true");
    });
    if (menuMode === "escape") {
      w.document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeMenu();
      });
    }
  }
  return {
    dom,
    clicks,
    clickTimes,
    menuOpen: () => Boolean(w.document.querySelector('[role="menu"]')),
  };
}

export const MENU_WITH_CONNECT = `
  <div role="menuitem" aria-label="Send profile in a message">Send profile in a message</div>
  <div role="menuitem">Save to PDF</div>
  <div role="menuitem" aria-label="Invite Jane Doe to connect"><span>Connect</span></div>
  <div role="menuitem">Report / Block</div>`;

/** The owner's Connect as an invitation-route link inside the More menu. */
export const MENU_WITH_CONNECT_LINK = `
  <div role="menuitem">Save to PDF</div>
  <a role="menuitem" href="/preload/custom-invite/?vanityName=jane-doe">Connect</a>`;

/** Connect controls that sit inside, or wrap, an element naming another member. */
export const MENU_WITH_FOREIGN_CONNECT = `
  <div role="menuitem">Save to PDF</div>
  <div role="menuitem" aria-label="Invite Alex Example to connect"><button>Connect</button></div>
  <button><span aria-label="Invite Sam Sample to connect">Connect</span></button>`;

export const MENU_WITH_REMOVE_CONNECTION = `
  <div role="menuitem">Save to PDF</div>
  <div role="menuitem" aria-label="Remove your connection to Jane Doe">Remove Connection</div>`;

export const MENU_WITHOUT_CONNECT = `
  <div role="menuitem">Save to PDF</div>
  <div role="menuitem">Report / Block</div>`;
