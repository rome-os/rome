const en = {
  server: {
    emailIntro:
      "👋 Hi — I'm {{agentName}}.\n\nFirst things first: let's make sure we can reach each other by email. Here's my address and the one I have for you — give it a look, and I'll send you a quick hello.",
    emailSentLead: "📬 Sent! It should land in a few seconds.",
    helloEmailSubject: "Hello from Rome 👋",
    helloEmailBody:
      "# Hello 👋\n\nI'm **{{agentName}}** — your new AI, here to help with whatever you need.\n\nThis is just a quick hello so we know email works between us. From here you can:\n\n- **Reply to this email** any time — I'll read it and get back to you.\n- Forward me anything you'd like me to handle.\n- Ask me to keep an eye on something and report back.\n\nTalk soon,\n\n**{{agentName}}**",
    greet: "Now, let me get to know you a little.\n\nTwo easy ways — pick whichever you like:",
    magicTrick:
      "✨ Watch the browser — I'll ask ChatGPT what it remembers about you and bring the highlights back. One moment…",
    chatgptNoMemory:
      "ChatGPT didn't have anything stored about you yet — no problem, let's just do the quick version.",
    chatgptFailed:
      "I couldn't read that from ChatGPT just now — let's do the quick version instead.",
    questionsLead: "Great — a few quick questions (tap or type, whatever's easier):",
    savingMemoryLead: "Thanks — folding that into your memory now.",
    scoutsLead:
      "I can also set up a few scouting tasks for your briefing app, so Rome keeps an eye on useful things for you.",
    ideasHandoffLead: "Got it. Brainstorming a few first apps for you…",
    ideasFailed: "I couldn't tailor these to you, but here are a few solid starters.",
    unexpectedError:
      "Something went wrong with the welcome — you can start chatting with Rome normally.",
    takeaway: "**What I took away**\n\n{{summary}}",
    pickedIdea: {
      heading: 'Let\'s build "{{title}}".',
      body: "Here's a prompt to kick it off — copy it into a normal chat with Rome when you're ready. You're all set!",
    },
    finishedNoPick: {
      heading: "You're all set.",
      body: "When you're ready to build something, just tell Rome what you have in mind. Welcome aboard.",
    },
    alreadyDone: {
      heading: "You've already finished the welcome.",
      body: "You can start chatting with Rome normally — or run it again below.",
    },
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
    emailHandshake: {
      confirmed: "Email confirmed",
      settingUp: "Setting up email…",
      unavailable: "Email isn't set up in this environment yet — we can sort that out later.",
      continue: "Continue",
      agentAddress: "My address",
      guardianAddress: "Yours",
      agree: "Looks right — say hello",
    },
    emailReceipt: {
      inbox: "your inbox",
      connected: "Thanks — we're connected.",
      sentTo: "I just emailed",
      sentAfter: ". Take a look — did it arrive?",
      received: "Got it",
      missing: "Didn't get it?",
      spamHint: "Check your spam / junk folder — first emails often land there. Still nothing?",
      resend: "Resend",
      continue: "Continue anyway",
    },
    introChoice: {
      importTitle: "Import from ChatGPT",
      importDescription: "Borrow what ChatGPT already remembers about you.",
      answerTitle: "Answer a few questions",
      answerDescription: "Tell me about yourself in a few quick taps.",
    },
    browserStep: {
      heading: "Let's borrow what ChatGPT knows about you ✨",
      openBefore: "Open the browser here: click",
      addBrowser: "➕ Add widget → Browser",
      openAfter: "(follow the arrow).",
      signIn: "Sign in to chatgpt.com in that browser.",
      returnWhenReady: "Come back and hit “I've signed in.”",
      openHeading: "Sign in to ChatGPT in the browser",
      openDescription: "Sign in to chatgpt.com on the right, then hit “I've signed in.”",
      notSignedIn: "I don't see ChatGPT signed in yet — sign in, then hit “I've signed in” again.",
      signedIn: "I've signed in",
      checking: "Checking…",
      skip: "Skip for now",
      skipSummary: "Skip — ask me questions",
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
    completion: {
      fallbackHeading: "You're all set.",
      copied: "Copied",
      copyPrompt: "Copy prompt",
      explore: "Browse more Rome apps and see what you can build next.",
      opening: "Opening…",
      openShowcases: "Open Showcases",
      runAgain: "Run the welcome again",
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
  introQuestions: [
    {
      id: "role",
      question: "What's your role or field?",
      type: "single",
      freeText: true,
      options: [
        "Engineering",
        "Design",
        "Product",
        "Founder / business",
        "Research",
        "Operations",
        "Marketing / content",
      ],
    },
    {
      id: "interests",
      question: "What are you into? Pick as many as apply.",
      type: "multi",
      freeText: true,
      options: [
        "Software & engineering",
        "AI & machine learning",
        "Data & analytics",
        "Science & research",
        "Design & UX",
        "Product & strategy",
        "Business & entrepreneurship",
        "Finance & investing",
        "Marketing & growth",
        "Writing & content",
        "Education & learning",
        "Health & fitness",
        "Productivity & organization",
      ],
    },
    {
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
    {
      id: "commStyle",
      question: "How should Rome talk to you?",
      type: "single",
      freeText: true,
      options: [
        "Short & to the point",
        "Detailed & thorough",
        "Casual & friendly",
        "Formal & professional",
      ],
    },
    {
      id: "anythingElse",
      question: "Anything else I should know?",
      type: "text",
      optional: true,
    },
  ],
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
