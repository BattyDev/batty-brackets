# Batty Brackets: prompts from prototype to tester

Follow these in order. Paste one task at a time, try the result, and keep fixes
in that task's chat. The aim is three useful connected views plus an isolated
demo, while conserving a Plus allowance. This document is a workflow to follow;
creating it has not started any implementation, changed a model, or deployed code.

## Set up the chat once

- Work in `batty-brackets/`. Keep this planning chat for priorities and use a
  new implementation chat for each numbered feature below.
- Select the recommended model in the app **before** sending the prompt.
  Naming a model in prose does not prove the active model changed.
- Prefer Standard speed. Use one working agent at a time, with no standing
  coordinator or automatic subagents. Slower execution alone does not save
  allowance; smaller models and less duplicate work are the useful controls.
- Luna High is the starting choice for focused coding; Sol Medium is for the
  persistence and server-command tasks. These are recommendations, not measured
  per-task usage guarantees. Use a model only if available in your picker.
- Both Codex and Claude should read AGENTS.md. When switching tools, use the
  handoff prompt below and stop the previous editor first.
- Continue on the same development branch sequentially. Separate worktrees
  are useful for simultaneous independent work; they are not needed for this
  sequential workflow. Do not automatically involve the sibling worktrees.

Paste this short preamble at the start of each **new** implementation chat,
followed by the selected task prompt:

```text
Work in batty-brackets and read AGENTS.md. Use TEST-READINESS.md for the relevant
finding, but check current code because earlier tasks may have resolved it.
Preserve existing work. Optimize for my Plus allowance over completion speed.
Use one agent with no subagents unless I explicitly request one. Read only
relevant files and reuse completed findings. Implement the requested outcome,
run focused checks, and review your diff once. Avoid adjacent cleanup and broad
refactors. Do not push, merge, deploy, or alter production data in this task.
Finish with what changed, checks actually run, known gaps, and at most five
manual test steps. Distinguish local, mocked-backend, and live-server evidence.
```

The recurring loop is **implement → focused checks → your manual test → fixes
if needed → local checkpoint**. Only move forward when the required behavior
works, or when a clearly recorded external prerequisite is the only blocker.
Do not count an untested connected workflow as complete.

## 0. Preserve the starting point

**Model:** Luna Medium. **One-time task.**

```text
Prepare a recoverable starting point for the tester work. Inspect the branch
and working diff, summarize the unfinished work briefly, and make a local
checkpoint commit of the existing project changes and relevant new files.
Preserve their contents; exclude generated output and machine-local files.
If currently on main, create a development branch first. Do not push.

Confirm how to run the app and focused browser tests using the installed
browser. Identify whether a disposable connected test environment is already
configured. Localhost is intentionally device-only: do not connect it to
production or claim it can test independent phones. If no non-production
backend is available, state the exact setup prerequisite for connected tests.
Do not implement features or repeat the whole repository review.
```

**You check:** a checkpoint commit exists, the correct checkout is in use, and
the agent has clearly identified how connected verification will be performed.
Keep the existing production publication gate. A local commit is not a deploy.

## 1. Make failed host saves recoverable

**Model:** Sol Medium. **No separate planning agent.**

```text
Implement priority 1 of TEST-READINESS.md: reliable connected host saves.
Start with the known failed-save/list-refresh reproduction. Briefly explain
your chosen approach, then implement it in this task.

Done when failed host edits remain recoverable across route changes and reload;
the UI distinguishes saving, saved, failed, and conflicting changes; retry
cannot silently overwrite a newer server revision; and incoming reads cannot
erase pending work. Scope pending work to the correct account and event.
Allow one active host editor for this pilot. Keep the existing architecture.

Use focused persistence/boundary checks for failure, retry, reload, stale
revision, and account separation. Add a small targeted test if existing tests
cannot catch the reproduced loss. Do not implement live polling yet.
```

**You check:** make a host edit, interrupt saving, reload, and confirm the edit
is visibly recoverable. Restore connectivity and retry. If you cannot induce a
real failure safely, ask the agent to demonstrate the focused simulated case.

## 2. Make untouched phone and TV screens update

**Model:** Luna High. Depends on task 1.

```text
Implement live refresh for the visible connected event, using the save/read
rules established in the previous task. Target host changes appearing on an
untouched online phone and TV within 10 seconds.

Prefer a small polling solution using existing commands. Prevent overlapping
requests, pause hidden-page polling, refresh on foreground/reconnect, and back
off on failures. Display stale/unavailable state honestly. Preserve pending
host edits, typed input, focus, and existing TV rotation. Clean up polling when
leaving the event. Do not rebuild the synchronization architecture.

Verify one host station call and one result reaching an independent reader,
plus disconnect/reconnect and navigation cleanup. State whether the transport
was mocked or a real test backend. Do not count shared localStorage as proof
of cross-device synchronization.
```

**You check:** use separate browser profiles or devices. Leave phone and TV
untouched while calling and finishing a match on the host. Observe updates and
the stale indicator after disconnecting a reader.

Use the focused review prompt below once for tasks 1–2 before building on them.

## 3. Let players submit match results

**Model:** Sol Medium for the complete first version. Keeping client and server
work together here avoids a coordination handoff on the critical path.

```text
Implement the smallest connected player result-submission workflow.
Pilot policy: a player in the match submits winner and score; the host accepts
or corrects it before bracket advancement. The host retains manual reporting.
Identify these controls distinctly from content-moderation reports.

Complete the server command, client boundary, minimal phone UI, and host review
action together. Verify ownership on the server; reject unrelated players and
stale/completed-match submissions appropriately. Repeated taps and retry after
an ambiguous response must not duplicate acceptance or bracket advancement.
Retain the player's choice after request failure and show its real status.

Keep schema changes in the repository's migration workflow. Use only the
identified disposable test backend for live validation. If it is unavailable,
finish reviewable code and focused tests, then report live validation blocked.
Do not add a generalized disputes, reputation, or notification system.
```

**You check:** submit a score on the phone, accept/correct it as host, and watch
the TV update. Try a repeated submission and a failed request. A success toast
alone is insufficient: confirm the accepted result and bracket state.

## 4. Let players withdraw

**Model:** Sol Medium. Depends on tasks 1–3.

```text
Implement a minimal connected withdrawal workflow for the player's own entry.
Before bracket generation, withdraw from participation without deleting the
player's identity/history. After generation, record a withdrawal request for
the host to resolve through the existing DQ/forfeit workflow; never silently
delete bracket nodes or rewrite completed results. Make that distinction clear
before the player confirms. Pending withdrawal must be visible to the host.

Enforce ownership and event/match state on the server. Handle duplicate taps,
retry, and closed/completed events. Keep UI limited to an action, confirmation,
and truthful status. Exercise both pre-bracket and active-event paths, including
the host resolving the request and the opponent's next state.
```

**You check:** withdraw once before seeding and once during play. Confirm the
host sees the request and that the opponent is not left in an impossible match.

Use the focused review prompt once for the new result/withdrawal boundaries.

## 5. Move the showcase into a separate demo

**Model:** Luna High.

```text
Create a separate demo entry page with Host, Player, and TV choices, reset,
and a link back to the real app. Reuse the working view modules.
Isolate sample storage, tour progress, and borrowed player identity from real
event data and authentication. The demo must not send production writes.

Remove automatic demo seeding and tour interruptions from normal event work.
Handle previously cached demo rows without wiping real events or sessions.
Keep existing device-only development useful with explicit demo access.
Update affected tour checks to use that entry point rather than weakening
assertions. Verify all three demo paths and reset isolation. Do not add a
marketing-site framework or copy the application into a second implementation.
```

**You check:** open a real event, visit and reset the demo, return, and confirm
the real event and your session are unchanged.

## 6. Make the player path lighter

**Model:** Luna High.

```text
Reduce initial player-page loading and friction. Load host editor, setup,
TV, and recovery code only when their routes need it. Preserve direct links,
navigation, delegated actions, loading/retry states, and the separate demo.

Keep the phone's main content to joining, current/next opponent and station,
result submission, and withdrawal. Keep rules and the full bracket accessible
through secondary links. Remove automatic profile-upgrade interruptions.
Do not remove required consent or server authorization checks.

Measure before/after resource loading on a fresh player arrival and exercise
the player path at 320px/390px. Use focused existing checks. Avoid frameworks,
new bundlers, service-worker/offline infrastructure, and a visual redesign.
```

**You check:** arrive from a tournament link on your phone. Join, find your
station, and submit a result without entering profile customization or opening
the full bracket. On poor connectivity, check for clear status and retained input.

## 7. Check host scale and TV readability

**Model:** Luna High. Keep this as a bounded measurement/fix task.

```text
Exercise the integrated host and TV views with 100 disposable entrants.
Measure roster interaction, station calls, result entry, connected save payload
and acknowledgement time, and propagation to TV. Separate local UI response
from server acceptance. Keep overview, manual correction, and station controls
easy to find; show now/up-next and completion clearly on the TV.

Fix reproducible problems found in those paths. Optimize only a measured
bottleneck; do not replace full-event saves or redesign the store speculatively.
Report the conditions and limits of the measurement. A 100-entrant event is
not a simulation of 100 concurrent clients. If live backend access is missing,
label connected latency unverified rather than substituting local timing.
```

**You check:** run the host at laptop width, then inspect the TV from across
the room. Record any hesitation, unreadable text, or lost typing/focus.

## 8. Prepare the external tester handoff

**Model:** Luna High; escalate a specific unresolved bug to Sol if necessary.

```text
Perform one integrated tester-readiness pass against TEST-READINESS.md.
Update that existing checklist with passed, failed, and blocked outcomes.
Run the full existing suite and backend static-contract check once. Do not
weaken checks to get green output or treat mocked checks as live-server proof.

Prepare a short tester script covering signup, check-in, station call, result
submission/approval, withdrawal, reconnect, correction, completion, and demo
isolation. Include the URLs/environment they should use and known limitations.
Use a real disposable connected environment for independent-client validation
if available. If not, identify this as a blocker to a connected pilot.

Fix only blockers found in those workflows, then rerun checks affected by the
fixes. Leave cosmetic preferences and unrelated features for my next iteration.
Do not deploy in this task. Finish with a clear ready/not-ready assessment.
```

**You check:** follow the tester script yourself once. Release/deployment is a
separate deliberate action after the existing CI gate and backend prerequisites
are satisfied. Local code passing does not mean database migrations are deployed.

## Reusable follow-ups

### Report a manual-test problem — same feature chat, usually Luna

```text
I tested this path:
Environment/device: [local demo / test backend; phone or desktop]
Starting page: [URL or route]
Actions: [short reproduction]
Expected: [observable behavior]
Actual: [what happened; paste the relevant error if present]

Fix this specific problem and run the relevant check. Preserve the accepted
parts of the feature. If you cannot reproduce it, ask for the smallest missing
detail rather than making speculative changes.
```

### Focused review — Sol Medium, only at the noted boundaries

Run after implementation finishes. This may be a fresh read-only chat or one
explicitly requested reviewer subagent. Give the exact commits/diff to inspect.

```text
Review [commit range or specific working diff] for [save recovery / match
submission / withdrawal]. Read AGENTS.md. Read-only: do not edit or delegate.
Focus on lost edits, duplicate acceptance, stale revisions, caller ownership,
and incorrect bracket advancement where relevant. Use the implementation's
test evidence; rerun only to investigate a concrete concern. Report actionable
findings with a reproduction or code explanation. Skip style preferences,
broad architecture suggestions, and unrelated existing issues. If there are
no findings, say so briefly and name any unverified boundary.
```

### Checkpoint accepted work — same feature chat

```text
My manual check passed. Create a local commit containing this feature's changes
and its relevant checks/docs, preserving unrelated work. Do not push. Update
the relevant item in TEST-READINESS.md briefly. Return the commit, remaining
limitations, and the next workflow task. Do not rerun checks without new changes
or an unresolved concern.
```

### Escalate a blocker or switch tools — only when needed

```text
Write a handoff of at most 250 words: goal and acceptance criteria, checkout
and branch, changed files, current behavior, exact blocker, attempts already
made, checks passed/skipped, and the next useful action. Do not edit further.
```

Then select Sol Medium (or open Claude with AGENTS.md) and provide that handoff:

```text
Continue from this handoff. Confirm the current diff, investigate the blocker,
and finish this feature. Reuse completed findings and tests; do not restart the
project review. Keep work within the stated scope. [Paste handoff.]
```

After two unsuccessful attempts at the same blocker, prefer this escalation
over repeated retries. A stronger model can be economical when it avoids a
long series of unsuccessful edits.

## Why this structure conserves work

Each prompt names an observable outcome, constraints, and evidence of completion.
Sequential tasks avoid duplicated exploration and integration conflicts.
Manual feedback settles product preferences before investing in broad protection.
Focused checks still protect persistence, permissions, and bracket correctness.
The full regression pass belongs at the integrated handoff, not every wording edit.

Model/usage guidance checked September 28, 2026:

- [Official model guidance](https://learn.chatgpt.com/docs/models): Luna for
  focused coding; Sol for complex coding; higher reasoning uses more tokens.
- [Official pricing and usage guidance](https://learn.chatgpt.com/docs/pricing):
  allowance depends on model, task, context, and tools; no task-count guarantee.
- [Official prompting practices](https://learn.chatgpt.com/guides/best-practices):
  provide goal, context, constraints, and a clear finish condition.
