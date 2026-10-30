// Puts every language in memory before `i18n/index.ts` initialises. Tests and
// Storybook import it first so `t()` answers in the first render, with no
// download to wait for. The app entry never imports it: that would put both
// languages back into the first-screen chunk.
import { bundleLoader } from "./bundle-loader";
import en from "./bundles/en";
import zhCN from "./bundles/zh-CN";

bundleLoader.register("en", en);
bundleLoader.register("zh-CN", zhCN);
