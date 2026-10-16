const en = {
  server: {
    greet:
      "👋 Hi {{guardianName}} — I'm {{agentName}}.\n\nBefore we start, a quick check: is this what I should call you, and do you like my name?",
    greetNoName:
      "👋 Hi — I'm {{agentName}}.\n\nBefore we start: what should I call you? And do you like my name?",
    connectAiLead:
      "Next, I need something to think with. I can run on your Claude or ChatGPT subscription rather than a separate API key.",
    capabilities:
      "Here's what I can do. Ask me to help with tasks, build apps, connect tools like Gmail and Slack, and run routines on a schedule. I also get better over time: I reflect on our conversations, remember what matters to you, and learn new skills.",
    questionLead: "Tell me about yourself, then we'll build something.",
    savingMemoryLead: "Thanks — folding that into your memory now.",
    ideasHandoffLead: "Got it. Brainstorming a few first apps for you…",
    ideasFailed: "I couldn't tailor these to you, but here are a few solid starters.",
    ideasOffline:
      "Without an AI connected I can't tailor these yet, so here are a few solid starters. Connect one from Settings any time.",
    unexpectedError:
      "Something went wrong with the welcome — you can start chatting with Rome normally.",
    takeaway: "**What I took away**\n\n{{summary}}",
    pickedIdea: 'Let\'s build "{{title}}".',
    buildBrief:
      "{{prompt}}\n\nIf you need to ask me anything, ask with the ask_question tool, not in plain text.",
    pickedIdeaDraft:
      "Let's build \"{{title}}\". I've opened a fresh chat with the kickoff prompt ready. Send it once an AI is connected.",
    pickedIdeaDraftReady:
      "Let's build \"{{title}}\". I've opened a fresh chat with the kickoff prompt ready. Send it whenever you like.",
    finishedAfterBuild:
      "You're all set. Explore a little: check out the built-in apps on the [Apps page](/apps), and the App Store for more. Welcome aboard.",
    finishedNoPick:
      "You're all set. Whenever you want to build something, tell me what you have in mind in a new chat. Welcome aboard.",
    alreadyDone:
      'You\'ve already finished the welcome. Start chatting with Rome normally, or say "start over" to run it again.',
  },
  web: {
    landing: {
      greeting:
        "Hi! So good to meet you. I'm {{agentName}} — I'll be helping you with pretty much everything from here on. Let me get you set up.",
      kickoff: "👋 Let's get started!",
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
    id: "weekLooksLike",
    question: "Which of these sounds most like your week?",
    type: "single",
    freeText: true,
    options: [
      "Hunting through email for one detail",
      "Twelve tabs open, none of them read",
      "Staring at an empty document",
      "Trying to remember what I promised whom",
      "Copying the same numbers between two places",
    ],
  },
};

export default en;
