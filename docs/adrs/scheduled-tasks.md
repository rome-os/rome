# Recurring work is a scheduled task

- **Status**: Accepted
- **Date**: 2026-11-12

## Context

An owner asked their Concierge for a work summary every day at 12:25. Nothing in the Concierge repeats, so the work went to a task chat, whose agent made a generic routine. The first routines ran in a background session, and the summary never reached the chat. The next one sent the routine's instruction into the Concierge chat as a message from the owner's agent. The owner saw the instruction as an odd bubble, and the Concierge answered it as if a person had written it.

A task already has what recurring work needs: a task chat that does the work, a report path that brings the result back and forwards its conclusion into the task's thread, checks that make a task later until they are due, and a digest note for a scheduled run with nothing to say.

## Decision

A task can carry a repeating schedule: every day, or on some weekdays, at a time in its owner's zone. It runs on the routine engine, one routine per task. At each run Rome sends the task's brief into the task's own task chat, as the Concierge's words, with no Concierge turn. The run comes back through the task's report path. Every run uses the same task chat, whose own session rules bound its context.

The schedule says whether each run is reported, or only one that asks the owner something or fails. A quiet run with nothing to ask goes into the next digest.

Between runs the task is later, and its next run is its check. Cancelling that check skips one run. Stopping or archiving the task removes the schedule. The Concierge sets one with `chat_start`, and changes or removes one with `task_upsert`.

## Alternatives

- **A generic routine that sends into the Concierge chat.** Rejected because it puts an instruction in the owner's timeline and has the Concierge answer an automation as if it were the owner. Any such send now runs as a quiet system turn instead.
- **A repeating `defer` that wakes the Concierge, which then sends to the task.** Rejected because every run would cost a Concierge turn that only passes the brief on, and a Concierge turn that failed would drop the run.
- **A new task chat for each run.** Rejected because the task would gain a chat per day, and one task links one task chat in its life.
- **A schedule kept on the task row.** Rejected because the routine engine already owns time zones, missed fires and run history, and a second scheduler would disagree with it.

## Consequences

A task with a schedule never ends between runs: it reads as later until it is stopped. A run's result is reported the way the brief's report setting says, and the Concierge forwards it as any task's.

Future diffs must respect:

- A schedule sends only into its task's own task chat.
- A run wakes no Concierge turn to send its brief.
- Cancelling a scheduled run's check skips that run and keeps the schedule. Stopping or archiving the task removes it.
- A run of a stopped or archived task sends nothing.
- A schedule's runs are not checks the Concierge put off: they never count toward a digest's review of postponed checks.
