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
