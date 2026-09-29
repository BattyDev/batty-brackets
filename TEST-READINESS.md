# Three-view tester readiness

Reviewed September 28, 2026 against this checkout, including its existing
uncommitted work. This is a prototype preparation plan, not a production signoff.
Assumption: next week's target is independent host, player, and TV devices.

## Verdict

The local tournament workflow is substantial enough to test now. Connected host
save recovery and event refresh have provisional client-side checkpoints, but
the connected experience still needs player match submission, withdrawal, and
live-server acceptance. A polished local demo must not be presented as proof
that these connected workflows work.

Keep the vanilla app. Prioritize completing these flows over adding features.
Platform administration, integrations, detailed profile customization, payments,
and pools/top-cut are outside this pilot's critical path.

## What each view should contain

| View | Primary screen | Keep secondary |
|---|---|---|
| Host, desktop | Event status, arrivals, station queue, results needing attention, manual corrections | Setup, roster import, seeding, rules, history and backup in existing tabs |
| Player, phone | Join by code/tag; current opponent, station and next action; submit result; withdraw | Full bracket, roster, rules and profile behind links; no account-upgrade interruption after joining |
| Live TV | Playing now, up next, readable names/stations, completed-event state, freshness status | Display controls tucked away; no host forms or player signup flow |
| Separate demo page | Choose Host / Player / TV, sample tournament, reset, return to real app | Reuse real view modules, with separate sample storage/session and no production writes |

## Fix in this order

1. **Make connected save outcomes trustworthy.**
   `lib/store.js:869-914` removes dirty events before saving; failure records an
   error without retaining a retryable command. `pullRemote` at line 1158 can
   replace the local event with the server copy and clear that error.

   A disposable mocked-backend probe reproduced this: rename an event, reject
   the save, then refresh the list. After failure, `pending=0` and `failed=0`;
   after refresh, the unsaved name is gone and the error is cleared. This was a
   local client probe, not a production database test.

   Preserve pending intent until acknowledgement, expose retry/conflict status,
   and protect it from incoming reads. For the pilot, one active host editor is
   a reasonable constraint. Reliable host internet does not eliminate rejected
   requests or revision conflicts. Do not automatically overwrite a newer
   server revision to make a retry succeed.

   Small usability cleanup: hide or visibly disable connected **Delete event**
   until supported. The button at `views/admin.js:1078` currently leads to an
   unavailable message; the handler at line 2022 correctly blocks deletion.

   **Provisional task 1 checkpoint (September 28):** The connected host store
   now persists per-event pending saves in the account-scoped local snapshot,
   preserves them across event/list reads and reload, and checks the server
   revision before retry. The header and recovery view show saving, saved,
   failed, and conflict states; connected event deletion is hidden. The
   focused mocked-backend boundary check passed for failure, refresh, reload,
   retry, stale revision, and account isolation. The local recovery browser
   suite passed with installed Chrome, and `git diff --check` passed. These
   checks do not establish live connected acceptance: no disposable staging
   backend is configured, and manual verification was skipped. Conflicts keep
   the local edit available for backup and require manual reconciliation.

2. **Keep player and TV screens current.**
   A list refresh alone cannot update an active bracket, station, and result
   bundle. Visible connected event routes use the existing event read.

   **Provisional task 2 checkpoint (September 28):** active connected UUID
   event routes poll the existing event-bundle read every five seconds, pause
   while hidden or offline, refresh on foreground/reconnect, prevent overlapping
   reads, and back off after failures. Host, player, and TV views show
   stale/offline state. The event row is merged through the same pending-save
   guard as its child rows, so reads cannot replace host edits. A focused
   browser check passed in separate host, phone, and TV contexts for a station
   call, a result, disconnect/reconnect, navigation cleanup, and the TV cycle
   display. Its transport was a mocked store backend. No disposable staging
   backend is configured, so live-server and manual cross-device acceptance
   remain unverified.

3. **Finish the small player workflow.**
   `views/event.js` has joining, check-in, documents, and opponent/station
   information. Match scoring is currently a host operation in
   `views/admin.js`; `views/report.js` is content moderation, not match scoring.
   There is no player match-result submission or withdrawal command in the
   inspected client boundary.

   Recommended cheap pilot policy: a player submits the winner and score; the
   host accepts or corrects it before the bracket advances. Defer a generalized
   dispute/trust system. Withdrawal before seeding removes the entry; after
   seeding it needs an explicit host-visible forfeit policy, not silent bracket
   deletion. Server commands must verify the caller owns the entry/match action.

   Use explicit sending, accepted, and failed/retry states. A failed request
   must preserve the entered choice; repeated taps/retries must not duplicate
   a result. Leave profile upgrades optional rather than automatically opening
   the current post-join upsell (`views/home.js:449`).

4. **Separate the demo and trim initial mobile loading.**
   `app.js:604-622` seeds demos into the normal entry path; home also exposes
   tour actions. Give the showcase its own entry page and isolated storage,
   leave real workflows free of seeded events/tour chrome, and retain the same
   underlying view modules so the demo does not become a second application.
   Old cached demo data needs a non-destructive transition; do not wipe real
   events or the user's account session.

   Static view imports at `app.js:30-37` load the host editor, setup, TV, profile
   and recovery modules even for a phone arrival. Lazy-load by route; prioritize
   the join/current-match screen. Do not add a framework/build system for this.
   Keep a useful loading/retry state while connection/auth initialization runs.

## Performance evidence and limits

- Fresh localhost page at 390px: 25 JavaScript resources and approximately
  **762 KiB decoded resources total**, with the host editor loaded. This is not
  compressed production transfer size or a cellular latency measurement.
- A disposable 100-entrant local demo generated 255 bracket matches. Five
  repeated desktop run-view draws at 1440px measured **47.8–57.2 ms** on this
  computer. This measures rendering work, not first paint or server saves.
- `connectedEventState` in `lib/store.js:854` sends the full roster, bracket,
  stations and results for host saves. Measure real payload/save latency at 100
  entrants before replacing it with narrow commands. No 100-user concurrency
  claim is supported by the local rendering probe.

Proposed pilot targets: host controls respond visibly within 100 ms locally;
players can reach the next action without opening a profile or full bracket;
TV/player data refresh within 10 seconds online. Measure slow-phone startup and
server acknowledgement separately instead of treating local feedback as a save.

## Manual handoff check

Use disposable event data and independent browser sessions/devices. A host tab
and TV tab sharing localStorage do not prove server synchronization.

1. Create a free eight-player event from a fresh host account; join from two
   phones, including a new guest. Check duplicate taps and full-capacity entry.
2. Check in, seed, call a match; leave phone and TV untouched. Both must show
   the new opponent/station within the agreed freshness target.
3. Submit a result from the phone, approve it as host, and confirm advancement
   everywhere. Correct one score and verify downstream bracket/station state.
4. Withdraw before seeding and during play; check the host-visible consequence
   and that the opponent is not left waiting for an impossible match.
5. Interrupt one player request, then reconnect/retry. Check no false success,
   duplicate submission, lost input, or permanently stale screen.
6. Reject one host save and introduce one stale revision. Pending work must
   remain visible/recoverable after navigation and reload, without clobbering
   newer accepted results. A refresh must not erase the failure silently.
7. Finish the event, including a grand-final reset; check the final TV state.
8. Repeat key host actions with 100 synthetic entrants. Record visible response
   time, server save time, payload size, and any typing/focus interruptions.
9. Enter/reset the separate demo, return to the real event, and verify the real
   event data and session are unchanged.

Until priorities 3 and 4 are complete, use LOCAL-REHEARSAL.md to review the
existing host/local experience. Mark missing player behavior and live-server
acceptance as blocked, not passed. No production deployment or live-server
validation was performed.

## Automated verification

- `node test/run.mjs`: **27/27 suites passed, zero skipped**, including the
  existing accessibility, mobile-player, host operations, rehearsal and TV
  checks. The first attempt could not launch the bundled Chromium; the completed
  run used installed Chrome through `BRACKETS_CHROMIUM` without installing
  dependencies or changing the harness.
- `node test/backend/contract-static.test.mjs`: passed.
- `git diff --check`: passed.
- Additional disposable probes: failed-save/list-refresh behavior and the
  local resource/render measurements above.

Existing suites exercise local and mocked flows; a green run does not cover
the missing workflows above or validate production RPC deployment. Application
code was reviewed but not changed in this pass. Changes are limited to this
plan, shared agent/Claude instructions, the README link and the local rehearsal
configuration correction. Existing uncommitted implementation work is preserved.
