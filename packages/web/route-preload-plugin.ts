import type { RsbuildPlugin } from "@rsbuild/core";

interface PreloadRule {
  /** `webpackChunkName` values of the dynamic imports whose files to preload. Each name's chunk group lists every file that import needs. */
  chunks: string[];
  /** A boolean expression that runs in the browser, with `p` (`location.pathname`) and anything `prelude` declares in scope. */
  when: string;
  /** Request the files only after every entry script has finished downloading. */
  afterEntry: boolean;
}

interface RoutePreloadOptions {
  /** Browser-side statements that run first, for helpers the `when` expressions share. */
  prelude?: string;
  rules: PreloadRule[];
}

/**
 * Starts the downloads a first screen will need from the HTML, in parallel
 * with the entry chunks, instead of after the entry has run and asked for them.
 *
 * `React.lazy` and `import()` only request a chunk once the entry executes, and
 * on a slow phone that is seconds after the network went idle. An inline script
 * adds preload links for the files of the chunks a rule names, when the rule's
 * condition holds for this visit. A visit to /login or a shared chat never pays
 * for the chat code.
 *
 * A rule with `afterEntry` waits until every entry script has downloaded. Sent
 * sooner, a large preload splits a slow connection with the entry chunks and
 * with the small requests the entry makes next, and pushes back the first
 * paint. Sent then, it uses the time the entry spends running.
 *
 * Builds only: the dev server's chunk files are unhashed and change on every
 * edit, and the browser warns about each preload the page has not used yet.
 */
export function pluginRoutePreload({ prelude = "", rules }: RoutePreloadOptions): RsbuildPlugin {
  return {
    name: "rome:route-preload",
    setup(api) {
      api.modifyHTMLTags(({ headTags, bodyTags }, { compilation, assetPrefix, filename }) => {
        if (api.context.action === "dev" || filename !== "index.html") {
          return { headTags, bodyTags };
        }
        const filesOf = (chunkName: string) => {
          const group = compilation.namedChunkGroups.get(chunkName);
          if (!group) throw new Error(`route-preload: no chunk group named "${chunkName}"`);
          return group
            .getFiles()
            .filter((file) => /\.(js|css)$/.test(file))
            .map((file) => `${assetPrefix}${file}`);
        };
        const body = rules
          .map((rule) => {
            const files = JSON.stringify(rule.chunks.flatMap(filesOf));
            return rule.afterEntry
              ? `if(${rule.when}){late.push.apply(late,${files})}`
              : `if(${rule.when}){add(${files})}`;
          })
          .join("");
        const script =
          `(function(){var p=location.pathname,late=[];${prelude}` +
          `function add(files){files.forEach(function(h){var l=document.createElement("link");l.rel="preload";` +
          `l.as=/\\.css$/.test(h)?"style":"script";l.href=h;document.head.appendChild(l)})}` +
          body +
          `if(late.length){var started=false,go=function(){if(!started){started=true;add(late)}};` +
          `try{var want=[].map.call(document.querySelectorAll("script[type=module][src]"),function(s){return s.src}),seen={};` +
          `var o=new PerformanceObserver(function(list){list.getEntries().forEach(function(e){seen[e.name]=1});` +
          `if(want.every(function(u){return seen[u]})){o.disconnect();go()}});` +
          `o.observe({type:"resource",buffered:true});addEventListener("load",go)}catch(e){go()}}})();`;
        headTags.push({ tag: "script", attrs: { "data-route-preload": "" }, children: script });
        return { headTags, bodyTags };
      });
    },
  };
}
