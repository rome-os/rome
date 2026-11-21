// Long and rich agent answers, shaped like real Concierge ones: a trip plan with a
// table, a release digest full of links and inline code, a morning digest, and
// a task chat report long enough to fold.

export const CONCIERGE_TRIP_PLAN = `## 京都三日行程

住在四条河原町附近，三天都以步行和巴士为主。

| 日期 | 上午 | 下午 | 晚上 |
| --- | --- | --- | --- |
| Day 1 · 11/21 六 | 伏见稻荷大社（早去人少） | 东福寺看红叶 | 先斗町晚饭 |
| Day 2 · 11/22 日 | 岚山竹林、天龙寺 | 嵯峨野小火车 | 锦市场 |
| Day 3 · 11/23 一 | 清水寺、二年坂 | 南禅寺、哲学之道 | 回大阪 |

### 注意

- 周末红叶季人多，**伏见稻荷建议 7 点前到**。
- 嵯峨野小火车要提前一个月在官网订票。
- 巴士一日券 700 円，三天里有两天用得上。`;

export const CONCIERGE_RELEASE_DIGEST = `### Rome this week

Seven PRs merged. The notable ones:

1. [Concierge header shows the own turn first](https://github.com/example/rome/pull/1964) — merged as [d37eb0f1c4a9e2b7f3d1a6c8e0b5f9a2d4c7e1b3](https://github.com/example/rome/commit/d37eb0f1c4a9e2b7f3d1a6c8e0b5f9a2d4c7e1b3).
2. [iPad support](https://github.com/example/rome/pull/1971): the split view uses \`NavigationSplitView\`, and \`defer\` blocks close the health store.
3. [Mac app releases on GitHub](https://github.com/example/rome/pull/1974) — the \`note\` field now carries the changelog.
4. [Rome Cloud notifications on desktop](https://github.com/example/rome/pull/1967).

Two are still open: [#1961](https://github.com/example/rome/pull/1961) waits for review, and [#1930](https://github.com/example/rome/pull/1930) needs a rebase onto \`main\`.`;

export const CONCIERGE_MORNING_DIGEST = `**Good morning.** Here is today:

- **Calendar:** design review at 10:00, dentist at 16:30.
- **Inbox:** 3 new. The landlord replied about the lease, and the bank statement is ready.
- **Packages:** the keyboard arrives today, before 18:00.
- **Reminders:** renew the passport (expires in 6 weeks).

Nothing needs you before 10:00.`;

export const CONCIERGE_FORWARDED_REPORT = `## Plumber visit report

The plumber came at 14:00 and stayed about an hour and a half.

### What was wrong

The leak under the kitchen sink came from a cracked compression fitting on the cold line, not from the drain as we thought. Water had been seeping into the cabinet floor for a while, so the bottom panel is swollen.

### What was done

- Replaced the compression fitting and both braided supply hoses.
- Checked the drain trap and tightened the slip nut; it was fine.
- Ran the tap for ten minutes with dry paper under the joints. No drip.

### Cost

| Item | Price |
| --- | --- |
| Call-out | €60 |
| Parts | €38 |
| Labour (1.5 h) | €90 |
| **Total** | **€188** |

The invoice is in your email. I paid it from the house account.

### Next steps

1. The cabinet floor needs replacing. The plumber suggested a carpenter; I asked Ray whether he knows one.
2. Keep the cabinet door open for two days so the wood dries out.
3. The plumber recommended checking the bathroom fittings too, since they are the same age. I can book that for next month if you want.`;

export const CONCIERGE_ATTENTION_DIGEST = `Morning digest — one item needs your attention:

**Main chat:** Ray asked whether Saturday's dinner is still on. [Open the main chat](/message)

日历提醒发到这里: [Google 日历](https://calendar.google.com/calendar/r/settings) · [Apple 日历](https://www.icloud.com/calendar/)`;

export const CONCIERGE_LAS_VEGAS_LIST = `## 拉斯维加斯首次到访：8 个值得优先考虑的景点 / 体验

**核实日期：2026 年 8 月 6 日。演出排期、开放时间和票价常有变动，出发前请在官网再确认一次。**

### Strip 地标与城市观景

1. **Bellagio 音乐喷泉＋季节花园｜经典、低预算首选**
   - **看点 / 适合谁：** 每 15–30 分钟一场的音乐喷泉，配上室内的季节花园，第一次来几乎必看，适合所有人。
   - **实用信息：** 免费；喷泉下午到午夜开放，花园全天开放。
   - **特别注意：** 晚上 8 点后人最多，想拍照建议提前到桥上占位。
2. **High Roller 摩天轮｜城市全景**
   - **看点 / 适合谁：** 一圈约 30 分钟，能看到整条 Strip，适合情侣和带孩子的家庭。
   - **实用信息：** 日落时段票价最高，网上提前买票有折扣。
   - **特别注意：** 有“欢乐时光”车厢，未满 21 岁不能进。
3. **The Sphere｜沉浸式影像**
   - **看点 / 适合谁：** 球形巨幕的沉浸式影片，外墙夜景本身就值得一看。
   - **实用信息：** 影片约 50 分钟，票价随场次浮动。
   - **特别注意：** 座位越高视角越好，恐高的人选低层。

### 城外一日游

4. **红岩峡谷｜自驾半日**
   - **看点 / 适合谁：** 离 Strip 约 30 分钟车程的红色砂岩峡谷，适合喜欢徒步和拍照的人。
   - **实用信息：** 需要提前预约入园时段。
   - **特别注意：** 夏天中午很热，带足水，尽量上午去。`;

/** A task chat's final answer: the details, then its conclusion between two HTML comments. */
export const TASK_CHAT_ANSWER_WITH_CONCLUSION = `## Flights to Lisbon, 1–7 March

I compared the fares from three sites for the first week of March. Prices are the round trip for one adult, in yuan.

| Option | Leaves | Returns | Stops | Price |
| --- | --- | --- | --- | --- |
| A | 2 Mar, 07:40 | 7 Mar, 18:05 | 1 | 4,380 |
| B | 2 Mar, 13:20 | 7 Mar, 11:10 | 1 | 4,910 |
| C | 3 Mar, 09:00 | 8 Mar, 15:30 | 0 | 6,240 |

### Notes

- Option A changes in Doha with a 70-minute layover, which is enough at that airport.
- Option C is the only direct flight, and it adds one night at the hotel.
- All three fares allow one free change within 24 hours of booking.

<!-- rome:conclusion -->
Found 3 round trips; the cheapest is option A at ¥4,380, leaving 2 March. Which one should I book?
<!-- /rome:conclusion -->`;

/** What the Concierge forwards of that answer: its conclusion, word for word. */
export const TASK_CHAT_CONCLUSION =
  "Found 3 round trips; the cheapest is option A at ¥4,380, leaving 2 March. Which one should I book?";
