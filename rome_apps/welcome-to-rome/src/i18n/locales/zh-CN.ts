const zhCN = {
  server: {
    greet:
      "👋 你好 {{guardianName}}，我是 {{agentName}}。\n\n开始之前先确认一下：我这样称呼你可以吗？你喜欢我的名字吗？",
    greetNoName: "👋 你好，我是 {{agentName}}。\n\n开始之前：我该怎么称呼你？你喜欢我的名字吗？",
    connectAiLead:
      "接下来，我需要一个可以用来思考的 AI。我可以使用你的 Claude 或 ChatGPT 订阅，而不需要单独的 API 密钥。",
    capabilities:
      "我能做的事情：帮你处理各种任务、构建应用、连接 Gmail 和 Slack 等工具，并按计划运行例行任务。我也会不断进步：我会回顾我们的对话，记住对你重要的事，并学习新技能。",
    questionLead: "先跟我说说你自己，然后我们一起做点东西。",
    savingMemoryLead: "谢谢，我正在把这些信息整理进你的记忆。",
    ideasHandoffLead: "了解。我正在为你想几个适合先做的小应用……",
    ideasFailed: "我暂时没能按你的情况定制，但这里有几个不错的起点。",
    ideasOffline:
      "还没有连接 AI，我暂时无法为你定制，这里有几个不错的起点。你随时可以在设置中连接一个。",
    unexpectedError: "欢迎流程出了点问题，不过你可以直接开始和 Rome 聊天。",
    takeaway: "**我记住了什么**\n\n{{summary}}",
    pickedIdea: "我们来做「{{title}}」。",
    buildBrief: "{{prompt}}\n\n如果需要问我问题，请用 ask_question 工具提问，不要直接用文字问。",
    pickedIdeaDraft:
      "我们来做「{{title}}」。我已经打开了一个新的聊天，启动提示词准备好了，连接 AI 后发送即可。",
    pickedIdeaDraftReady:
      "我们来做「{{title}}」。我已经打开了一个新的聊天，启动提示词准备好了，随时发送即可。",
    finishedAfterBuild:
      "设置完成。四处看看吧：[应用页面](/apps)里有内置应用，应用商店里还有更多。欢迎加入。",
    finishedNoPick: "设置完成。想做点什么时，在新的聊天里告诉我你的想法就好。欢迎加入。",
    alreadyDone: "你已经完成欢迎流程。现在可以直接和 Rome 聊天，或者说「重新开始」再来一次。",
  },
  web: {
    landing: {
      greeting:
        "你好，很高兴认识你。我是 {{agentName}}，之后会协助你处理各种事情。我们先完成设置。",
      kickoff: "👋 开始设置吧！",
      start: "开始聊天",
      opening: "正在打开…",
      openError: "暂时无法打开聊天。请再试一次。",
    },
    names: {
      guardianLabel: "我怎么称呼你",
      agentLabel: "你怎么称呼我",
      confirm: "没问题",
      summary: "{{guardianName}} · {{agentName}}",
    },
    scouts: {
      skippedSummary: "已跳过 Briefing 观察任务",
      addedSummary: {
        one: "已添加 {{count}} 个 Briefing 观察任务",
        other: "已添加 {{count}} 个 Briefing 观察任务",
      },
      addedHeading: "Briefing 观察任务已添加",
      skippedHeading: "已跳过 Briefing 观察任务",
      addLater: "之后可以在 Briefing 应用中添加观察任务。",
      heading: "为你的 Briefing 添加观察任务",
      description: "它们会在后台运行，并把有用的发现整理到早晚简报中。",
      adding: "正在添加",
      added: "已添加",
      add: "添加",
      continue: "继续",
      skip: "暂时跳过",
      error: "无法添加此观察任务（{{status}}）。",
      interval: {
        minutes: "{{minutes}} 分钟",
        daily: "每天",
        days: "每 {{days}} 天",
        hours: "每 {{hours}} 小时",
      },
    },
    ideas: {
      heading: "选择第一个要做的应用",
      build: "开始构建",
      explore: "我想自己探索",
      exploreSummary: "我想自己探索",
    },
  },
  genericIdeas: [
    {
      title: "心情日记",
      prompt:
        "帮我做一个日记应用，让我每天记录心情、发生的事、见过的人和笔记。提供日历视图、可搜索的条目，以及简单的每周心情趋势，方便我回顾长期规律。",
    },
    {
      title: "培养习惯",
      prompt:
        "帮我做一个习惯追踪应用，让我定义几个重复习惯、每天打卡，并在友好的仪表盘中查看连续天数和每周进度。",
    },
    {
      title: "阅读书架",
      prompt:
        "帮我做一个阅读清单应用，让我粘贴链接、添加笔记和标签、标记正在阅读或已完成的内容，并能按主题或状态在之后浏览。",
    },
  ],
  introQuestion: {
    id: "weekLooksLike",
    question: "下面哪个最像你的一周？",
    type: "single",
    freeText: true,
    options: [
      "在邮件里翻找一条信息",
      "开了十几个标签页，一个都没看完",
      "对着空白文档发呆",
      "想不起来答应过谁什么事",
      "在两个地方之间反复复制同样的数字",
    ],
  },
};

export default zhCN;
