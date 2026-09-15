import type { StreamBlock } from "@/lib/chat-types";
import { appBuildingChat } from "./app-building-chat";

export interface DemoChat {
  id: string;
  name: string;
  project: string;
  turns: {
    at: string;
    prompt: string | StreamBlock[];
    reply: string;
    blocks?: StreamBlock[];
  }[];
}

// Authored product scenarios and an edited shared conversation. All app links
// open the recorded samples. Provenance: docs/dashboard-mock-mode.md.
export const curatedChats: DemoChat[] = [
  appBuildingChat,
  {
    id: "mock-chat-learn-video",
    name: "Turn a long video into a learning kit",
    project: "default",
    turns: [
      {
        at: "2026-09-15T16:00:00.000Z",
        prompt:
          "I want to understand how ChatGPT works, but I don't have time to watch all of Andrej Karpathy's Deep Dive into LLMs like ChatGPT. Turn it into something I can explore and share with my team.",
        reply: `Your learning kit is ready in **YouTube Distill**.

| Format | Use it for |
| --- | --- |
| Mind map | Explore how pre-training, supervised fine-tuning, and reinforcement learning fit together |
| Summary | Read the main ideas before deciding which parts to study |
| 11-slide deck | Walk your team through the material |
| Transcript excerpt | See a short passage from the original video |

**The central idea:** pre-training teaches a model patterns in text. Later training shapes those capabilities into an assistant that can follow instructions and improve through feedback.

[Open the learning kit](/apps/yt-distill/llm-deep-dive)`,
      },
      {
        at: "2026-09-15T16:05:00.000Z",
        prompt:
          "Give me a 15-minute path through it. I'm presenting to people who don't write code.",
        reply: `## A 15-minute walkthrough

1. **Minutes 0–4 · The big picture.** Open the mind map and follow the three training stages. Describe tokens as the small pieces of text a model reads and predicts.
2. **Minutes 4–10 · The explanation.** Use the slide deck to explain how predicting text becomes a conversational assistant. Keep the discussion on examples, rather than model internals.
3. **Minutes 10–13 · The limits.** Read the summary's discussion of hallucinations and verification. Ask the team which answers they would check before acting on them.
4. **Minutes 13–15 · Questions.** Return to the mind map and let the audience choose a branch to explore next.

[Open the mind map, summary, and slides](/apps/yt-distill/llm-deep-dive)`,
      },
    ],
  },
  {
    id: "mock-chat-fitness-plan",
    name: "Make room for a daily workout",
    project: "default",
    turns: [
      {
        at: "2026-09-15T15:00:00.000Z",
        prompt:
          "I sit at a desk all day and keep putting off exercise. Give me a beginner plan I can follow at home in 20 minutes. I want short videos, some posture work, and Sundays off.",
        reply: `I've put together a week in **Fitness Tracker**. Each training day has four five-minute video modules, with a warm-up at the start and a stretch at the end.

| Day | Focus | Time |
| --- | --- | --- |
| Monday | Full body | 20 min |
| Tuesday | Core | 20 min |
| Wednesday | Lower body | 20 min |
| Thursday | Upper body | 20 min |
| Friday | Cardio | 20 min |
| Saturday | Posture | 20 min |
| Sunday | Rest | — |

The plan uses **14 videos** across the week. Open **Today** to follow the day's sequence, **Week Plan** to see the whole week, or **Library** to browse the exercises.

[Open your workout plan](/apps/fitness-tracker)`,
      },
      {
        at: "2026-09-15T15:04:00.000Z",
        prompt:
          "What's on the plan for Tuesday? I need something I can start without setting anything up.",
        reply: `Tuesday is a **20-minute core session**:

1. **5 Min Warm Up (No Jumping)** — an easy start without equipment.
2. **5 Minute Plank Challenge** — a sequence of plank variations.
3. **5 Min Cardio for Beginners** — 40 seconds of activity, then 20 seconds of rest.
4. **Full Body Cool Down & Stretch** — finish with a calmer pace.

Each module has its own video, so you can follow one at a time.

[Open Fitness Tracker](/apps/fitness-tracker)`,
      },
    ],
  },
  {
    id: "mock-chat-market-brief",
    name: "Have the market recap ready every day",
    project: "default",
    turns: [
      {
        at: "2026-09-15T14:00:00.000Z",
        prompt:
          "I spend too much time jumping between finance sites after the market closes. Set up an English recap every weekday at 1:30 PM Los Angeles time, and email it to guardian@example.com. Include sources so I can look into anything interesting.",
        reply: `Your weekday recap is set up in **Stock Daily**.

| Setting | Schedule |
| --- | --- |
| Runs | Monday–Friday at 1:30 PM |
| Time zone | America/Los_Angeles |
| Delivery | guardian@example.com |
| Language | English |

Each report brings together the major indexes, sector moves, macro developments, notable stocks, and source links. Reports stay in the app so you can return to an earlier day.

Two completed reports are ready to explore:

- [September 11 market recap](/apps/stock-daily/reports/report-2026-09-11)
- [September 10 market recap](/apps/stock-daily/reports/report-2026-09-10)

[Open Stock Daily and its schedule](/apps/stock-daily)`,
      },
      {
        at: "2026-09-15T14:03:00.000Z",
        prompt: "When I'm short on time, where should I start?",
        reply: `Start with the **executive summary**, then scan these sections:

- **Major Index Overview** for the day's direction and the comparison across indexes.
- **Sector Performance** for where gains and losses were concentrated.
- **Key Stock News and Notable Moves** for company-specific developments.

The report links to sources alongside the analysis. Follow those links when you want to check a number or read the underlying announcement.

[Read the September 11 report](/apps/stock-daily/reports/report-2026-09-11)`,
      },
    ],
  },
];
