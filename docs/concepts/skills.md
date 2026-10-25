# Skills

Skills are instructional documents that teach [agents](agents.md) how to accomplish specific tasks. Unlike [actions](actions.md), skills do not execute code — they provide knowledge and step-by-step guidance that an agent reads as part of its prompt.

A skill is a markdown document with front matter declaring its name, its description (which carries any trigger phrases), and the tool subset the agent should use while following it. The body is a structured workflow — phases, validation checkpoints, examples — written for an LLM reader.

**Contracts:**

- Skill frontmatter declares a [local artifact name](apps.md#artifact-names-and-references). The name cannot contain `:`. Rome exposes the skill by its canonical `<app-id>:<local-name>` id.
- A qualified slash invocation or `read_skill` call uses the canonical id, such as `/coding:app_creation`. A bare name is accepted only through legacy compatibility.
- A skill is *loaded*, not *executed*: when a task matches its description, the agent loads the body into its context for that turn. A skill never runs code itself.
- Skills are owned by [apps](apps.md#rome-apps). Adding or modifying a skill takes effect on the next install of its owning app, and disabling an app removes its skills from the catalog.
- The skill catalog is a flat index, not a hierarchy: skills from any app are equally discoverable.
- Agents do not carry every skill in their prompt: skills are searched and injected on demand, so the catalog must stay cheap to traverse.

**Not to be confused with:**

- **[Action](actions.md)** — an action executes code. A skill is instructions an agent follows.
- **[Memory](data.md#memory)** — memory is knowledge about the guardian and their world. A skill is task know-how, shipped by an app.
