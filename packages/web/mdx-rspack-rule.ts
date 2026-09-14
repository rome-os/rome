import remarkGfm from "remark-gfm";

/** MDX design docs use GFM tables for their rule/reason columns. */
export function createMdxRspackRule() {
  return {
    test: /\.mdx$/,
    use: [{ loader: "@mdx-js/loader", options: { remarkPlugins: [remarkGfm] } }],
  };
}
