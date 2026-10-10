import { readFileSync } from "node:fs";
import { describe, expect, it } from "@rstest/core";
import {
  type AppIdentity,
  renderAppIdentity,
  renderSocialMeta,
  type SocialCard,
} from "./social-meta.js";

const SHELL = [
  "<html><head>",
  "    <title>Rome</title>",
  "    <!-- explainer -->",
  "    <!-- rome:social:start -->",
  '    <meta property="og:type" content="website" />',
  '    <meta property="og:title" content="Rome OS - Enjoy your life with Rome" />',
  '    <meta property="og:image" content="https://romeos.cc/public-og-20260825.jpg" />',
  "    <!-- rome:social:end -->",
  '    <script src="/runtime-config.js"></script>',
  "</head><body></body></html>",
].join("\n");

const card: SocialCard = {
  title: "Reddit Radar",
  description: 'AI agent <radar> & "dashboard"',
  url: "https://jessie.romeos.cc/full/apps/reddit",
  imageUrl: "https://jessie.romeos.cc/app-og/reddit.png?v=1",
};

describe("renderSocialMeta", () => {
  it("returns the shell untouched when there is no card", () => {
    expect(renderSocialMeta(SHELL, null)).toBe(SHELL);
  });

  it("replaces the title and the marked block, escaping attribute values", () => {
    const html = renderSocialMeta(SHELL, card);
    expect(html).toContain("<title>Reddit Radar · Rome</title>");
    expect(html).not.toContain("Rome OS - Enjoy your life with Rome");
    expect(html).toContain('<meta property="og:title" content="Reddit Radar" />');
    expect(html).toContain(
      '<meta property="og:description" content="AI agent &lt;radar&gt; &amp; &quot;dashboard&quot;" />',
    );
    expect(html).toContain(
      '<meta property="og:url" content="https://jessie.romeos.cc/full/apps/reddit" />',
    );
    expect(html).toContain(
      '<meta property="og:image" content="https://jessie.romeos.cc/app-og/reddit.png?v=1" />',
    );
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain(
      '<meta name="twitter:image" content="https://jessie.romeos.cc/app-og/reddit.png?v=1" />',
    );
    // Everything outside the block survives.
    expect(html).toContain("<!-- explainer -->");
    expect(html).toContain('<script src="/runtime-config.js"></script>');
    expect(html).toContain("<!-- rome:social:start -->");
    expect(html).toContain("<!-- rome:social:end -->");
  });

  it("keeps every emitted meta tag on its own single line", () => {
    const html = renderSocialMeta(SHELL, card);
    const block = html.split("<!-- rome:social:start -->")[1].split("<!-- rome:social:end -->")[0];
    for (const line of block.trim().split("\n")) {
      expect(line.trim()).toMatch(/^<meta [^\n]*\/>$/);
    }
  });

  it("returns the shell untouched when the markers are missing", () => {
    const noMarkers = "<html><head><title>Rome</title></head></html>";
    expect(renderSocialMeta(noMarkers, card)).toBe(noMarkers);
  });

  it("treats a title containing $-patterns as literal text, not a replacement pattern", () => {
    const html = renderSocialMeta(SHELL, { ...card, title: "Cost $& Co" });
    expect(html).toContain("<title>Cost $&amp; Co · Rome</title>");
  });

  it("keeps the shell's own og:image when the card has no imageUrl", () => {
    const html = renderSocialMeta(SHELL, { ...card, imageUrl: undefined });
    expect(html).toContain(
      '<meta property="og:image" content="https://romeos.cc/public-og-20260825.jpg" />',
    );
    expect(html).toContain(
      '<meta name="twitter:image" content="https://romeos.cc/public-og-20260825.jpg" />',
    );
    expect(html).toContain('<meta property="og:title" content="Reddit Radar" />');
  });

  it("omits og:description and twitter:description when the card has no description", () => {
    const html = renderSocialMeta(SHELL, { ...card, description: undefined });
    expect(html).not.toContain("og:description");
    expect(html).not.toContain("twitter:description");
    expect(html).toContain('<meta property="og:title" content="Reddit Radar" />');
  });

  it("omits image tags when neither the card nor the shell has one", () => {
    const shellWithoutImage = [
      "<html><head>",
      "    <title>Rome</title>",
      "    <!-- rome:social:start -->",
      '    <meta property="og:type" content="website" />',
      '    <meta property="og:title" content="Rome OS - Enjoy your life with Rome" />',
      "    <!-- rome:social:end -->",
      "</head><body></body></html>",
    ].join("\n");
    const html = renderSocialMeta(shellWithoutImage, { ...card, imageUrl: undefined });
    expect(html).not.toContain("og:image");
    expect(html).not.toContain("twitter:image");
    expect(html).toContain('<meta property="og:title" content="Reddit Radar" />');
  });
});

describe("the document title and og:title", () => {
  it("appends the site name to the document title and leaves og:title bare", () => {
    const html = renderSocialMeta(SHELL, card);
    expect(html).toContain("<title>Reddit Radar · Rome</title>");
    expect(html).toContain('<meta property="og:title" content="Reddit Radar" />');
    expect(html).toContain('<meta name="twitter:title" content="Reddit Radar" />');
  });

  // The SPA recomposes the same title once it takes over, so a direct load that
  // disagrees with the client flashes on hydration.
  it("composes it the way the dashboard does", () => {
    const pageTitle = readFileSync(
      new URL("../../../web/src/lib/page-title.ts", import.meta.url),
      "utf8",
    );
    expect(pageTitle).toContain('const SITE_NAME = "Rome";');
    expect(pageTitle).toContain('const SEPARATOR = " · ";');
  });
});

const IDENTITY_SHELL = [
  "<html><head>",
  "    <!-- rome:app-identity:start -->",
  '    <link rel="manifest" href="/manifest.webmanifest" />',
  '    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
  '    <meta name="apple-mobile-web-app-title" content="Rome" />',
  '    <meta name="application-name" content="Rome" />',
  "    <!-- rome:app-identity:end -->",
  '    <meta name="apple-mobile-web-app-capable" content="yes" />',
  "</head><body></body></html>",
].join("\n");

const identity: AppIdentity = {
  name: 'Tic <Tac> & "Toe"',
  manifestUrl: "/app-manifest/ttt.webmanifest",
  iconUrl: "/app-icon/ttt.png?v=abc123def456",
};

describe("renderAppIdentity", () => {
  it("returns the shell untouched when there is no identity or no markers", () => {
    expect(renderAppIdentity(IDENTITY_SHELL, null)).toBe(IDENTITY_SHELL);
    expect(renderAppIdentity(SHELL, identity)).toBe(SHELL);
  });

  it("replaces every tag in the block, escaping the name", () => {
    const html = renderAppIdentity(IDENTITY_SHELL, identity);
    expect(html).toContain('<link rel="manifest" href="/app-manifest/ttt.webmanifest" />');
    expect(html).toContain(
      '<link rel="apple-touch-icon" href="/app-icon/ttt.png?v=abc123def456" />',
    );
    const title = 'content="Tic &lt;Tac&gt; &amp; &quot;Toe&quot;"';
    expect(html).toContain(`<meta name="apple-mobile-web-app-title" ${title} />`);
    expect(html).toContain(`<meta name="application-name" ${title} />`);
    // Replaced, not added to: iOS reads the first title tag it finds.
    expect(html).not.toContain("/manifest.webmanifest");
    expect(html).not.toContain('content="Rome"');
    expect(html.match(/apple-mobile-web-app-title/g)).toHaveLength(1);
    // Tags outside the block are left alone.
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
  });

  it("keeps the shell's own touch icon when the app has no icon", () => {
    const html = renderAppIdentity(IDENTITY_SHELL, { ...identity, iconUrl: undefined });
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(html).toContain('<link rel="manifest" href="/app-manifest/ttt.webmanifest" />');
  });

  it("finds the markers in the real shell", () => {
    const shell = readFileSync(new URL("../../../web/index.html", import.meta.url), "utf8");
    const html = renderAppIdentity(shell, identity);
    expect(html).toContain('<link rel="manifest" href="/app-manifest/ttt.webmanifest" />');
    expect(html.match(/apple-mobile-web-app-title/g)).toHaveLength(1);
    expect(html.match(/rel="manifest"/g)).toHaveLength(1);
  });
});
