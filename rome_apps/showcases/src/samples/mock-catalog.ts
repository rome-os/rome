import {
  type PresetCatalog,
  SHOWCASE_PRESET_CATALOG_SCHEMA,
  SHOWCASE_PRESET_CATALOG_VERSION,
} from "../trace/portable.js";

// Curated showcase catalog (interim mock). Served by the app's GET /presets
// endpoint and rendered by the gallery as category sections of CTA cards.
//
// `traceUrl` is set only for cards with a published "see how it was built" trace.
// App cards link to the demo deployment's full-page app route. System cards use
// internal soft navigation (the SDK's navigateRome bridge) or an external link
// (the Rome Cloud app store).
const DEMO_BASE = "https://demo.romeos.cc";
const appUrl = (slug: string): string => `${DEMO_BASE}/full/apps/${slug}`;

// App Store listing for a sample app — the whole card links here (`cardHref`),
// while the in-card "Preview app" CTA opens the live demo deployment.
const STORE_BASE = "https://romeos.cc/store";
const storeUrl = (appId: string): string => `${STORE_BASE}/${appId}`;

export const MOCK_PRESET_CATALOG: PresetCatalog = {
  schema: SHOWCASE_PRESET_CATALOG_SCHEMA,
  version: SHOWCASE_PRESET_CATALOG_VERSION,
  categories: [
    {
      id: "system",
      title: "System",
      items: [
        {
          id: "connect-channel",
          icon: "Send",
          title: "Connect a channel",
          description: "Reach your agent from Telegram, WhatsApp, Discord, or web chat.",
          mainCta: { label: "Open settings", navigate: { path: "settings", tab: "channels" } },
          traceUrl: null,
        },
        {
          id: "connect-apps",
          icon: "Plug",
          title: "Connect apps",
          description: "Connect Gmail, Calendar, GitHub, Slack, and more to your agent.",
          mainCta: { label: "Open settings", navigate: { path: "settings", tab: "connections" } },
          traceUrl: null,
        },
        {
          id: "browse-apps",
          icon: "Store",
          title: "Browse the app store",
          description: "Discover and install apps that give your agent new powers.",
          mainCta: { label: "Browse apps", href: "https://romeos.cc/store" },
          traceUrl: null,
        },
      ],
    },
    {
      id: "lifestyle",
      title: "Lifestyle",
      items: [
        {
          id: "food-tracker",
          icon: "Utensils",
          title: "Food Tracker",
          description:
            "Snap a photo or type a meal, then track calories and macros against your goals.",
          mainCta: { label: "Preview app", href: appUrl("food-tracker") },
          cardHref: storeUrl("food-tracker"),
          tryCta: {
            label: "Remix",
            draft:
              "Make me an app where I log meals by snapping a photo or typing them in, and it estimates the calories and macros. Show my daily progress toward my goals and give me nutrition tips.",
          },
          traceUrl: null,
        },
        {
          id: "fitness-tracker",
          icon: "Dumbbell",
          title: "Fitness Tracker",
          description: "Track workouts, habits, and progress toward your personal fitness goals.",
          mainCta: { label: "Preview app", href: appUrl("fitness-tracker") },
          cardHref: storeUrl("fitness-tracker"),
          tryCta: {
            label: "Remix",
            draft:
              "Make me a fitness tracking app where I can log workouts, track habits, monitor progress toward goals, and see trends over time.",
          },
          traceUrl: null,
        },
        {
          id: "soundtrack-studio",
          icon: "Music",
          title: "Soundtrack Studio",
          description: "Create and organize custom soundtracks for moods, projects, and moments.",
          mainCta: {
            label: "Preview app",
            href: appUrl("soundtrack-studio"),
          },
          cardHref: storeUrl("soundtrack-studio"),
          tryCta: {
            label: "Remix",
            draft:
              "Make me a soundtrack studio app where I can create, organize, and save custom soundtracks for moods, projects, and moments.",
          },
          traceUrl: null,
        },
      ],
    },
    {
      id: "social",
      title: "Social",
      items: [
        {
          id: "parallel-answers",
          icon: "Users",
          title: "Parallel Answers",
          description:
            "Everyone answers the same prompt blindly, then see the reveal once you submit.",
          mainCta: { label: "Preview app", href: appUrl("parallel-answers") },
          cardHref: storeUrl("parallel-answers"),
          tryCta: {
            label: "Remix",
            draft:
              "Make me an app where my friends and I all answer the same daily question, but you only see everyone else's answers after you submit your own. Add a reveal page with emoji reactions.",
          },
          traceUrl: null,
        },
        {
          id: "bestie-quiz",
          icon: "Heart",
          title: "Bestie Quiz",
          description:
            "Create a quiz about yourself, share it with friends, and rank who knows you best.",
          mainCta: { label: "Preview app", href: appUrl("bestie-quiz") },
          cardHref: storeUrl("bestie-quiz"),
          tryCta: {
            label: "Remix",
            draft:
              'Build a "How well do you know me?" quiz app similar to the parallel-answers app where one user can start a quiz, pick questions from a large pool and answer them, then share the quiz with their friends. Their friends can then guess what the user answered initially, and the friends are ranked by how many they answer correctly. This helps you find the bestie. Make the app attractive to GenZ',
          },
          traceUrl: null,
        },
      ],
    },
    {
      id: "travel",
      title: "Travel",
      items: [
        {
          id: "travel-atlas",
          icon: "Map",
          title: "Travel Atlas",
          description: "Pin your travel photos to a world map and keep a diary book for each city.",
          mainCta: { label: "Preview app", href: appUrl("travel-atlas") },
          cardHref: storeUrl("travel-atlas"),
          tryCta: {
            label: "Remix",
            draft:
              "Make me an app where I upload my travel photos and they get pinned to a world map by where they were taken. Organize them into a diary book for each city with notes and stickers.",
          },
          traceUrl: null,
        },
      ],
    },
    {
      id: "finance",
      title: "Finance",
      items: [
        {
          id: "robinhood-monitor",
          icon: "Wallet",
          title: "Robinhood Monitor",
          description:
            "Take read-only snapshots of your portfolio and get alerts when positions move.",
          mainCta: { label: "Preview app", href: appUrl("robinhood-monitor") },
          cardHref: storeUrl("robinhood-monitor"),
          tryCta: {
            label: "Remix",
            draft:
              "Make me an app that connects to my Robinhood account and takes read-only snapshots of my portfolio. Let me check my positions and get alerts when things move — no trading, just monitoring.",
          },
          traceUrl: null,
        },
        {
          id: "stock-analyst",
          icon: "ChartCandlestick",
          title: "Stock Analyst",
          description:
            "Analyze stocks with watchlists, market context, and AI-assisted investment research.",
          mainCta: { label: "Preview app", href: appUrl("stock-analyst") },
          cardHref: storeUrl("stock-analyst"),
          tryCta: {
            label: "Remix",
            draft:
              "Make me an app that helps analyze stocks with watchlists, market context, company fundamentals, and AI-assisted research notes. Let me compare symbols and save investment theses.",
          },
          traceUrl: null,
        },
      ],
    },
    {
      id: "education",
      title: "Education",
      items: [
        {
          id: "number-hunt",
          icon: "Calculator",
          title: "Number Hunt",
          description:
            "A two-player math game — find your opponent's target number and fill your board first.",
          mainCta: { label: "Preview app", href: appUrl("number-hunt") },
          cardHref: storeUrl("number-hunt"),
          tryCta: {
            label: "Remix",
            draft:
              'Create a two person math game. The shared board will randomly have some number of different orientations. One person A can post a target number and the other person B needs to find that number; while B is finding, A can draw "X" on their canvas board. Once B finds the number, they can click the shared board to confirm. The two switch turn each round and the first who fills their own board wins.',
          },
          traceUrl: null,
        },
        {
          id: "color-pals",
          icon: "Palette",
          title: "Color Pals",
          description:
            "Pick line drawings, fill them with bright colors, then save and share the artwork.",
          mainCta: { label: "Preview app", href: appUrl("color-pals") },
          cardHref: storeUrl("color-pals"),
          tryCta: {
            label: "Remix",
            draft:
              "Design a children's line art app. The app should provide various children's line drawings and a variety of colors for children to pick from to fill the color in the drawings. After they are done, children can save and share their artwork. Design an app that is attractive to kids",
          },
          traceUrl: "https://demo.romeos.cc/share/TMLGxMOAWTOAS_RlkUYyvfHOUE6mPB1O7CHvGHRWqJw",
        },
      ],
    },
    {
      id: "fun",
      title: "Fun",
      items: [
        {
          id: "arcana",
          icon: "Moon",
          title: "Arcana",
          description: "Tarot spreads, daily horoscopes, and your natal chart under a starry sky.",
          mainCta: { label: "Preview app", href: appUrl("arcana") },
          cardHref: storeUrl("arcana"),
          tryCta: {
            label: "Remix",
            draft:
              "Make me a tarot and astrology app with card readings, a daily horoscope, and a natal chart from my birth details. Give it a beautiful night-sky design.",
          },
          traceUrl: null,
        },
        {
          id: "texas-holdem",
          icon: "Spade",
          title: "Texas Holdem",
          description: "Play poker hands, manage the table, and practice Texas Holdem strategy.",
          mainCta: { label: "Preview app", href: appUrl("texas-holdem") },
          cardHref: storeUrl("texas-holdem"),
          tryCta: {
            label: "Remix",
            draft:
              "Make me a Texas Holdem app where I can play poker hands, manage a table, track chips, and practice strategy against computer players.",
          },
          traceUrl: null,
        },
        {
          id: "spin-art",
          icon: "Disc3",
          title: "Spin Art",
          description:
            "Make colorful spinning artwork with playful controls and save the finished design.",
          mainCta: { label: "Preview app", href: appUrl("spin-art") },
          cardHref: storeUrl("spin-art"),
          tryCta: {
            label: "Remix",
            draft:
              "Make me a spin art app where I can choose colors, adjust the spinning canvas, create playful abstract artwork, and save or share the finished design.",
          },
          traceUrl: null,
        },
        {
          id: "dig-drop",
          icon: "Shovel",
          title: "Dig Drop",
          description:
            "Play a digging arcade game with falling pieces, buried paths, and quick decisions.",
          mainCta: { label: "Preview app", href: appUrl("dig-drop") },
          cardHref: storeUrl("dig-drop"),
          tryCta: {
            label: "Remix",
            draft:
              "Make me a Dig Drop game where players dig paths, dodge falling pieces, collect points, and try to survive as the board gets harder.",
          },
          traceUrl: null,
        },
      ],
    },
  ],
};
