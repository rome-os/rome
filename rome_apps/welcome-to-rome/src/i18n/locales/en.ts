const en = {
  server: {
    greet:
      "👋 Hi {{guardianName}} — I'm {{agentName}}.\n\nBefore we start, a quick check: is this what I should call you, and do you like my name?",
    connectAiLead:
      "Next, I need something to think with. Sign in to Claude or ChatGPT below — I run on your existing subscription — or skip for now and I'll keep it simple.",
    questionLead: "One question, then we build something:",
    savingMemoryLead: "Thanks — folding that into your memory now.",
    scoutsLead:
      "I can also set up a few scouting tasks for your briefing app, so Rome keeps an eye on useful things for you.",
    ideasHandoffLead: "Got it. Brainstorming a few first apps for you…",
    ideasFailed: "I couldn't tailor these to you, but here are a few solid starters.",
    ideasOffline:
      "Without an AI connected I can't tailor these yet, so here are a few solid starters. Connect one from Settings any time.",
    unexpectedError:
      "Something went wrong with the welcome — you can start chatting with Rome normally.",
    takeaway: "**What I took away**\n\n{{summary}}",
    pickedIdea:
      "Let's build \"{{title}}\". I've opened a fresh chat with the kickoff prompt ready — send it when you're ready.",
    finishedNoPick:
      "You're all set. Whenever you want to build something, tell me what you have in mind in a new chat. Welcome aboard.",
    alreadyDone:
      'You\'ve already finished the welcome. Start chatting with Rome normally, or say "start over" to run it again.',
  },
  web: {
    landing: {
      greeting:
        "Hi! So good to meet you. I'm {{agentName}} — I'll be helping you with pretty much everything from here on. Let me get you set up.",
      kickoff: "Let's get started 👋",
      start: "Start chat",
      opening: "Opening…",
      openError: "Couldn't open the chat just yet — give it another tap.",
    },
    names: {
      guardianLabel: "What I call you",
      agentLabel: "What you call me",
      confirm: "Looks good",
      summary: "{{guardianName}} · {{agentName}}",
    },
    scouts: {
      skippedSummary: "Skipped briefing scouts",
      addedSummary: {
        one: "Added {{count}} briefing scout",
        other: "Added {{count}} briefing scouts",
      },
      addedHeading: "Briefing scouts added",
      skippedHeading: "Briefing scouts skipped",
      addLater: "You can add scouts later from the Briefing app.",
      heading: "Add scouts to your briefing",
      description:
        "These run in the background and roll useful findings into your morning and evening briefs.",
      adding: "Adding",
      added: "Added",
      add: "Add",
      continue: "Continue",
      skip: "Skip for now",
      error: "Could not add this scout ({{status}}).",
      interval: {
        minutes: "{{minutes}} min",
        daily: "Daily",
        days: "Every {{days}} days",
        hours: "Every {{hours}}h",
      },
    },
    ideas: {
      heading: "Pick your first app to build",
      build: "Build this",
      explore: "I'll explore on my own",
      exploreSummary: "I'll explore on my own",
    },
  },
  genericIdeas: [
    {
      title: "Mood diary",
      prompt:
        "Build me a diary app where I can record my mood, events, people, and notes each day. Give me a calendar view, searchable entries, and simple weekly mood trends so I can reflect on patterns over time.",
    },
    {
      title: "Habit garden",
      prompt:
        "Build me a habit tracker where I can define a few recurring habits, check them off daily, and see streaks and weekly progress in a friendly dashboard.",
    },
    {
      title: "Reading shelf",
      prompt:
        "Build me a reading-list app where I can paste links, add notes and tags, mark items as reading or finished, and browse everything later by topic or status.",
    },
  ],
  introQuestion: {
    id: "helpFirst",
    question: "What would you love help with first?",
    type: "single",
    freeText: true,
    options: [
      "Email & messages",
      "Research & summaries",
      "Writing & content",
      "Scheduling & reminders",
      "Building little tools",
    ],
  },
  scouts: {
    templates: [
      {
        id: "ai",
        keywords: ["ai", "machine learning", "ml", "llm", "agent", "openai", "anthropic"],
        title: "AI launches radar",
        reason: "AI and agent updates",
        intervalMinutes: 360,
        prompt:
          "Search public sources from the last 6 hours for important AI, LLM, and agent product launches or research updates. Prioritize OpenAI, Anthropic, Google DeepMind, Meta AI, major labs, arXiv, Hacker News, and credible engineering blogs. Return up to 5 items with links, one-line context, and why each matters.",
      },
      {
        id: "engineering",
        keywords: ["software", "engineering", "developer", "programming", "code", "devtools"],
        title: "Developer tooling watch",
        reason: "software engineering",
        intervalMinutes: 720,
        prompt:
          "Look for notable developer tooling releases, framework updates, infrastructure incidents, and engineering writeups from the last 12 hours. Favor primary release notes and credible technical sources. Return up to 5 items with links, who should care, and a short practical takeaway.",
      },
      {
        id: "data",
        keywords: ["data", "analytics", "dashboard", "metrics", "bi"],
        title: "Data stack watch",
        reason: "data and analytics",
        intervalMinutes: 720,
        prompt:
          "Scan public sources from the last 12 hours for meaningful data, analytics, warehouse, BI, and observability updates. Include product launches, breaking changes, strong technical posts, or notable benchmarks. Return a concise list with links and why each item is worth the guardian's attention.",
      },
      {
        id: "research",
        keywords: ["research", "science", "paper", "academic", "biology", "physics", "chemistry"],
        title: "Research paper radar",
        reason: "science and research",
        intervalMinutes: 1440,
        prompt:
          "Find new or newly discussed research papers from the last day in the guardian's scientific and technical interest areas. Prioritize papers with practical implications, strong discussion, or major updates. Return up to 5 papers with title, link, field, one-sentence summary, and why it matters.",
      },
      {
        id: "design",
        keywords: ["design", "ux", "user experience", "product design", "interface"],
        title: "Design signal scan",
        reason: "design and UX",
        intervalMinutes: 1440,
        prompt:
          "Search public design, product, and UX sources from the last day for strong case studies, interface patterns, design-system releases, and research writeups. Return up to 5 items with links, what changed, and one concrete idea the guardian could reuse.",
      },
      {
        id: "product",
        keywords: ["product", "strategy", "founder", "startup", "business", "entrepreneur"],
        title: "Product launch watch",
        reason: "product and business",
        intervalMinutes: 720,
        prompt:
          "Look for notable product launches, startup moves, pricing changes, and strategy posts from the last 12 hours in the guardian's domains. Prioritize primary announcements and credible analysis. Return up to 5 items with links, what happened, and the strategic implication.",
      },
      {
        id: "finance",
        keywords: ["finance", "investing", "market", "stocks", "crypto", "personal finance"],
        title: "Market-moving brief",
        reason: "finance and investing",
        intervalMinutes: 360,
        prompt:
          "Scan public financial news and market commentary from the last 6 hours for items likely to affect the guardian's interests. Include macro, earnings, policy, major company news, and crypto only when material. Return up to 5 items with source links, the move, and the practical takeaway.",
      },
      {
        id: "marketing",
        keywords: ["marketing", "growth", "content", "creator", "writing", "newsletter"],
        title: "Audience trend scout",
        reason: "marketing and content",
        intervalMinutes: 1440,
        prompt:
          "Find strong examples, platform changes, and audience-growth tactics from the last day across marketing, content, newsletters, and creator ecosystems. Return up to 5 items with links, what is working, and how the guardian might adapt it.",
      },
      {
        id: "education",
        keywords: ["education", "learning", "teaching", "course", "student"],
        title: "Learning resources scout",
        reason: "education and learning",
        intervalMinutes: 1440,
        prompt:
          "Search public sources from the last day for high-quality learning resources, courses, explainers, or education technology updates related to the guardian's interests. Return up to 5 items with links, who it is for, and why it is worth saving.",
      },
      {
        id: "news",
        keywords: ["news", "current events", "politics", "policy", "world"],
        title: "Current events filter",
        reason: "news and current events",
        intervalMinutes: 360,
        prompt:
          "Scan credible public news sources from the last 6 hours for major current events relevant to the guardian's stated interests. Avoid noise and duplicates. Return up to 5 items with links, what changed, and why it matters.",
      },
      {
        id: "health",
        keywords: ["health", "fitness", "wellness", "nutrition", "medicine"],
        title: "Health research watch",
        reason: "health and fitness",
        intervalMinutes: 1440,
        prompt:
          "Find credible health, fitness, wellness, or nutrition updates from the last day. Prefer primary research, public-health guidance, and expert sources over viral claims. Return up to 5 items with links, evidence quality, and the practical takeaway.",
      },
      {
        id: "travel",
        keywords: ["travel", "trip", "flights", "hotel", "cities"],
        title: "Travel opportunity watch",
        reason: "travel",
        intervalMinutes: 1440,
        prompt:
          "Look for travel updates from the last day that could matter to the guardian, including destination news, fare trends, airline changes, visa updates, and practical guides. Return up to 5 items with links and why each is useful.",
      },
      {
        id: "sports",
        keywords: ["sports", "nba", "nfl", "soccer", "football", "baseball", "tennis"],
        title: "Sports storyline scout",
        reason: "sports",
        intervalMinutes: 720,
        prompt:
          "Search public sports sources from the last 12 hours for notable games, roster moves, injuries, standings changes, and storylines in the guardian's sports interests. Return up to 5 items with links and why each one matters.",
      },
    ],
    fallbacks: [
      {
        title: "Personal interest radar",
        reason: "your interests",
        intervalMinutes: 720,
        prompt:
          "Search public sources from the last 12 hours for notable updates connected to the guardian's stated interests and current work. Prefer primary sources, credible analysis, and items with practical implications. Return up to 5 items with links, a one-line summary, and why each matters.",
      },
      {
        title: "Useful links digest",
        reason: "learning and discovery",
        intervalMinutes: 1440,
        prompt:
          "Find high-signal articles, tools, papers, videos, or explainers from the last day that match the guardian's broad interests. Avoid generic news. Return up to 5 links with a short summary and why each is worth reading.",
      },
      {
        title: "Briefing prep scout",
        reason: "daily briefings",
        intervalMinutes: 360,
        prompt:
          "Before the next briefing, look for timely public updates that could be useful to the guardian based on their role, interests, and recent onboarding context. Return a concise list of the best items with links and why they belong in the briefing.",
      },
    ],
  },
};

export default en;
