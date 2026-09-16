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
