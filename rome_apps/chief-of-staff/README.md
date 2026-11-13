# Chief Of Staff

A chief of staff agent for a team. It knows the team and its goals, and it answers when a member addresses it in a chat such as Discord.

The agent knows the team only from two documents the team owns: a **roster** and a **goals document**. It reads them through its `read_team` action, and it cites them as the source of everything it says about a person or a goal. When the documents and the chat do not answer a question, the agent says it does not know rather than guess.

This is phase 1. The agent answers when it is addressed. It does not yet draw on messages it was not addressed in, and it does not yet post on its own.

## What the team gets

- It names every member, their role, and what they are working on, from the roster.
- It states each current goal with its owner and date, from the goals document, and leaves out a goal the team has dropped.
- In a direct message it knows which member it is talking to, from the person their Discord account is linked to. It never guesses a sender from a display name.
- It names a source for every answer, and says so when it does not know.
- It answers in the chat and the thread the message was said in.
- It keeps to itself anything said in a direct message or a chat only some of the team can read.

## Edit the roster and the goals

Open the app in the dashboard. It shows the roster and the goals document, each in a box you edit and save. The agent reads the saved text on its next answer, so a change shows within one answer and survives a restart.

Write the roster with one member per heading: their name, their role, and what they are working on now. Write the goals with one goal per heading: the goal, its owner, its date, and whether it is active or dropped. The agent reads these as plain documents, so any clear layout works.

## Setup

The agent reaches the team through one Discord bot, connected as one of Rome's connected accounts. Only the guardian can do the steps below.

### 1. Connect the Discord bot

Create a Discord application and a bot, turn on its **Message Content** intent, and invite it to the team's server. In Rome, connect it as a Discord bot connection and paste the bot token. This makes a connected account for the bot.

### 2. Link the agent to the connected account

On the connected account, set its agent to **Chief Of Staff** (`chief-of-staff:chief-of-staff`). Now a message the bot hears wakes this agent.

### 3. Link each member's Discord account to a person

Rome tells the agent who it is talking to by the person behind the Discord account, not by the display name on the message. For that, each member's Discord account is linked to a person on Rome's People page. Only the guardian links an account. A member with two Discord accounts has both linked to the same person.

Put the same members in the roster, so the name the agent reads matches the person Rome names.

### 4. Set how the agent replies in each chat

By default a Discord chat starts a new thread for each bot reply, and a mention requires the bot to be named. For the agent to answer a mention in the same chat the mention was said in (rule A5), run `/channel thread off` in each chat the agent is in. The reply then lands in that chat, in the thread the message was said in. Leave the default mention requirement on, so the agent answers when it is addressed and stays quiet otherwise.

### 5. Decide who the agent answers directly

Rome answers a member directly only when their bond level is one the guardian trusts. Put each member at the **inner circle** bond level on the People page, and add that level to Rome's "reply to" and "trusted" sender settings. A member below a trusted level reaches the agent only through sender triage, not directly.

## What this phase does not do

- It cannot yet attribute each message in a group chat to the right person (rule K3). Rome tells the agent who sent a message only once per chat, so attribution holds in a chat with one member, such as a direct message, and not yet in a group chat. Fixing it is a change to Rome that is still being designed.
- It does not draw on messages it was not addressed in. "What did we decide yesterday?" waits for phase 2.
- It keeps no memory of a chat between answers. Each answer reads the roster and the goals document fresh, which is why its answers are the same after a session renewal and a restart (rule K6), and also why nothing a member says in a chat changes its answers yet (the phase 2 gap for rule K4).
- It posts nothing on its own. Suggestions and reports wait for phase 3.
