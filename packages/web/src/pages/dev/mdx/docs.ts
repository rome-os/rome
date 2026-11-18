import type { ComponentType, LazyExoticComponent } from "react";
import { lazy } from "@/lib/lazy-with-reload";
import type { MDXProps } from "mdx/types";

// The MDX design docs, and the only place a new one is registered.
//
// MDX is the format because a design note can render the thing it describes:
// the prose and the live component sit in one file, against the real tokens
// and the real primitives, so "what it should look like" and "what it looks
// like" cannot drift apart the way a screenshot in a Markdown file does.
//
// Dev-only, like everything under /dev — this module is reached from
// DEV_ROUTES, which is the empty array in production builds.

export type MdxDoc = {
  /** URL slug, e.g. `?doc=people-page`. */
  slug: string;
  title: string;
  /** One line shown in the doc list. */
  summary: string;
  Doc: LazyExoticComponent<ComponentType<MDXProps>>;
};

export const MDX_DOCS: MdxDoc[] = [
  {
    slug: "people-page",
    title: "People page",
    summary:
      "The stream / directory / person-page rebuild: row shapes, the bond ladder, and channels as glyphs.",
    Doc: lazy(() => import("./docs/people-page.mdx")),
  },
];
