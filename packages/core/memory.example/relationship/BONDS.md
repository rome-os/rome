# Relationship Bonds

## Tier Definitions

### Guardian
The person this agent is dedicated to. Full trust, full memory.

**What to track:**
- Complete profile (name, timezone, communication preferences)
- All preferences, habits, and routines
- Communication style (tone, verbosity, formality)
- Important dates (birthday, anniversaries, recurring events)
- Ongoing projects and context
- Stored in: `memory/relationship/GUARDIAN.md`

### Inner Circle
Close friends, family, and trusted contacts of the guardian.

**What to track:**
- Full name, nicknames, and how the guardian refers to them
- Preferences and interests relevant to the guardian
- Important dates (birthdays, anniversaries)
- Conversation topics and history
- Relationship dynamics with the guardian (e.g., "college roommate", "sister")
- Communication style preferences
- Channel mappings (Telegram ID, WhatsApp ID)
- Stored in: `memory/relationship/<person-id>.md`

### Acquaintance
People the guardian knows but is not close to.

**What to track:**
- Name and how they know the guardian
- Key context relevant to the guardian's interactions with them
- Last interaction summary
- Channel mappings
- Stored in: `memory/relationship/<person-id>.md`

### Other
Known contacts with minimal relationship to the guardian.

**What to track:**
- Name and relationship to guardian only
- Channel mappings
- Stored in: `memory/relationship/<person-id>.md`

> **Strangers**: Do NOT remember anything. Do not create profiles.

## How to Classify People

When deciding which tier a person belongs to, follow these rules:

1. **Default to "Other"** unless there is evidence of a closer relationship.
2. **Promote to "Acquaintance"** when the guardian has had multiple interactions with the person, or the guardian refers to them by name in conversation.
3. **Promote to "Inner Circle"** only when the guardian explicitly says so, or when the relationship is clearly close (e.g., "my best friend", "my mom", "my partner").
4. **Never self-promote** a person's tier. If uncertain, ask the guardian before upgrading.
5. **The guardian can override** any tier assignment at any time by editing this file or telling the agent.

## Name Conflict Resolution

When a new person has the same display name as an existing person:
1. Check channel and channelUserId to see if it's the same person on a different platform.
2. If a different person, append a disambiguator (e.g., "John (work)" vs "John (gym)").
3. Always confirm with the guardian.

---

## Inner Circle

<!-- People in the guardian's inner circle -->
<!-- Format: - [person-id](person-id.md) — relationship to guardian -->

## Acquaintance

<!-- Acquaintances of the guardian -->
<!-- Format: - [person-id](person-id.md) — how they know the guardian -->

## Other

<!-- Other known contacts -->
<!-- Format: - [person-id](person-id.md) — context -->
