import { describe, expect, it } from "@rstest/core";
import { DEFAULT_SOCIAL_IMAGE_URL, renderSocialMeta, type SocialCard } from "./social-meta.js";

const SHELL = [
  "<html><head>",
  "    <title>Rome</title>",
  "    <!-- explainer -->",
  "    <!-- rome:social:start -->",
  '    <meta property="og:type" content="website" />',
  '    <meta property="og:title" content="Rome OS - Enjoy your life with Rome" />',
  `    <meta property="og:image" content="${DEFAULT_SOCIAL_IMAGE_URL}" />`,
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
    expect(html).toContain("<title>Reddit Radar</title>");
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
    expect(html).toContain("<title>Cost $&amp; Co</title>");
  });
});
