import { lazy, type ComponentType, type LazyExoticComponent } from "react";

// Single source of truth for the dev-only pages under `src/pages/dev/`.
//
// This registry is consumed in TWO places, so a new dev page means adding ONE
// entry here and nothing else:
//   1. App.tsx maps it to a `<Route>` (gated behind `import.meta.env.DEV`).
//   2. DevIndexPage renders it as a link on the `/dev` index.
//
// Production drop-out: `import.meta.env.DEV` is a Vite build-time constant that
// is statically `false` in production. `DEV_ROUTES` is the empty array in prod,
// and — critically — each entry's `lazy(() => import(...))` is constructed ONLY
// inside that dead branch, so the page chunks are never emitted or linked. An
// unconditional top-level `lazy(() => import("./Page"))` would still ship an
// orphaned chunk even if nothing rendered it, so the dynamic imports must stay
// behind the gate.

export type DevRoute = {
  /** Route path, e.g. "/dev/styleguide". Also the index-page link target. */
  path: string;
  /** Short label shown on the /dev index. */
  title: string;
  /** One-line description shown on the /dev index. */
  description: string;
  /** Lazy-loaded page component (default export). */
  Component: LazyExoticComponent<ComponentType>;
};

export const DEV_ROUTES: DevRoute[] = import.meta.env.DEV
  ? [
      {
        path: "/dev/styleguide",
        title: "Style guide",
        description:
          "Design-system gallery: every semantic token in light + dark, all ui/ primitive variants, and the shadow-DOM theme-parity panel.",
        Component: lazy(() => import("./StyleGuidePage")),
      },
      {
        path: "/dev/typography",
        title: "Typography specimen",
        description:
          "Every typography role at its live values — spec table read back via getComputedStyle, locale-file sample copy in en + zh-CN, in-context assemblies, and per-role size/leading preview.",
        Component: lazy(() => import("./TypographyPage")),
      },
      {
        path: "/dev/gallery",
        title: "Component gallery",
        description:
          "Live specimens of every ui/ and @rome-os/ui primitive — variants, sizes, and states, with theme and mode switches.",
        Component: lazy(() => import("./gallery/ComponentGalleryPage")),
      },
      {
        path: "/dev/connections",
        title: "Connection gallery",
        description: "Prototype gallery of connection / credential-slot card states.",
        Component: lazy(() => import("./ConnectionGalleryPage")),
      },
      {
        path: "/dev/chat-blocks",
        title: "Transcript blocks",
        description:
          "Every component renderSingleBlock dispatches to, rendered from a literal StreamBlock — the blocks an agent state gates, which no product route renders on load.",
        Component: lazy(() => import("./ChatBlocksPage")),
      },
      {
        path: "/dev/mdx",
        title: "Design docs (MDX)",
        description:
          "MDX design notes that render live components — prose and the specimen it describes in one file, against the real tokens and primitives.",
        Component: lazy(() => import("./mdx/MdxDocsPage")),
      },
      {
        path: "/dev/login",
        title: "Login page",
        description:
          "The real LoginPage in its local sign-in phase. Reachable without a signed-out backend, which the route under AuthGate needs.",
        Component: lazy(() => import("./LoginPreviewPage")),
      },
      {
        path: "/dev/onboard",
        title: "Onboarding page",
        description:
          "The real OnboardPage on its create-account step. Reachable without an un-onboarded backend, which the route under AuthGate needs.",
        Component: lazy(() => import("./OnboardPreviewPage")),
      },
    ]
  : [];
