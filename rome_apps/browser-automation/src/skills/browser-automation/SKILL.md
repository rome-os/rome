---
name: browser-automation
description: Route browser tasks to specialized Rome apps or OpenCLI, and author browser automation actions with tested scripts and explicit navigation boundaries.
tools: [Bash, Read, Grep]
---

# Browser Automation

Use this skill when a task requires browser automation, web interaction, page inspection, scraping, or scripted browser control.

## Routing

1. Prefer specialized Rome apps for browser automation. Search installed Rome apps, actions, and skills for a domain-specific capability before using a generic browser tool.
2. If a specialized Rome app is available, use that app's action or skill and follow its instructions.
3. If no specialized app is available, run bash command `opencli <site> --help` to check whether OpenCLI is available and what browser automation commands it exposes.
4. Use OpenCLI only after checking `opencli <site> --help` and selecting a command that matches the task.

## Browser connections

OpenCLI uses its browser extension by default. Run `opencli profile list` to discover connected browsers before choosing a target.
Pass `opencli --profile <name-or-id> ...` on every command for a task so concurrent work does not change its browser.
If the requested browser is disconnected, report that it is unavailable. Do not substitute another browser or assume its login session is equivalent.
Settings > Advanced > Computer Use shows observed browser connections and their last seen times.
Use `--cdp-endpoint` only when the task explicitly requires a direct CDP connection.

The available sites are:
1688, 36kr, 51job, amazon, antigravity, apple-podcasts, arxiv, baidu-scholar, band, barchart, bbc, bilibili, binance, bloomberg, bluesky, boss, chaoxing, chatgpt, chatgpt-app, chatwise, claude, cnki, codex, coupang, craigslist, ctrip, cursor, dblp, deepseek, devto, dianping, dictionary, discord-app, douban, doubao, doubao-app, douyin, eastmoney, facebook, gemini, gitee, google, google-scholar, gov-law, gov-policy, grok, hackernews, hf, hupu, imdb, indeed, instagram, jd, jianyu, jike, jimeng, ke, lesswrong, linkedin, linux-do, lobsters, maimai, medium, mubu, notebooklm, notion, nowcoder, ones, openreview, paperreview, pixiv, producthunt, quark, reddit, reuters, sinablog, sinafinance, smzdm, spotify, stackoverflow, steam, substack, taobao, tdx, ths, tiktok, toutiao, twitter, uiverse, v2ex, wanfang, web, weibo, weixin, weread, wikipedia, xianyu, xiaoe, xiaohongshu, xiaoyuzhou, xueqiu, yahoo-finance, yollomi, youtube, yuanbao, zhihu, zlibrary, zsxq

## Authoring browser automation actions

1. Discover the browser controls through the routing steps above.
2. Navigate to the target page and wait for it to be ready.
3. Write the JavaScript and test it in the browser console before saving it in the action's `scraping_scripts` directory.
4. Split the action at each navigation boundary. Navigate to page A, wait, and run script A. Then navigate to page B, wait, and run script B.
5. Collect the result and close the page when no further action needs it.

A script can trigger navigation, such as when it submits a form. That navigation destroys the JavaScript execution context. Run subsequent work in a separate step after the destination page is ready, not in the same script.

## Per-user OpenCLI scripts

Save a script when the same browser task comes up a second time, a routine or workflow will run it, or the user asks. Keep one-off exploration interactive.

Use `~/.rome/<active-profile>/projects/browser-automation/<site>/`, a normal project visible in the Projects UI. Each site folder contains:
- `opencli-plugin.json` with `"name": "user-<site>"`.
- `package.json` containing `{"type":"module"}`.
- One flat `.js` file per command, calling `cli()` from `@jackwener/opencli/registry`.
- A `README.md` listing the commands.

1. Complete the task interactively first.
2. Write the command in the site folder.
3. For a new site folder, run `opencli plugin install <dir>` once. The install symlinks the folder, so edits are live on the next invocation.
4. Test with `opencli <site> <cmd> -f json`.
5. Add a command line to the plugin README.

Use the rendered page, not private APIs or auth tokens. Commands that change something must only verify by default and require an explicit flag such as `--send` to act. Fail on auth walls instead of returning partial data.

Overrides of Rome or upstream commands are allowed. List each override in the plugin README, start its file with a comment naming the command it replaces, and redeclare that command's aliases. Overrides stop receiving Rome's fixes. When touching one, compare it with the current Rome version and delete it if it no longer adds anything.
