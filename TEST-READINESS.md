# Three-view tester readiness

Reviewed September 28, 2026 against this checkout, including its existing
uncommitted work. This is a prototype preparation plan, not a production signoff.
Assumption: next week's target is independent host, player, and TV devices.

## Verdict

The local tournament workflow is substantial enough to test now. The requested
connected experience is not ready yet: live refresh, recovery from failed host
saves, player match submission, and withdrawal need work. A polished local demo
must not be presented as proof that these connected workflows work.

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

2. **Keep player and TV screens current.**
   Event hydration in `app.js:389` runs on entry/navigation. The timers at the
   end of that file update clocks and local overview rendering, not server
   event data. A second device can remain on an old station call indefinitely.

   Start with bounded polling of the visible event, plus refresh on foreground
   and reconnect, using the existing read command. A proposed pilot target is
   updates within 10 seconds while online. Pause hidden-page polling, prevent
   overlapping reads, back off after failure, and show when data is stale.
   Resolve step 1 before allowing background reads over host edits. A list
   refresh alone is not a refresh of the active bracket/station bundle.

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

Until the four implementation priorities are complete, use
`LOCAL-REHEARSAL.md` to review the existing host/local experience. Mark missing player/live behavior as blocked,
not passed. No production changes or live-server validation were performed in
this review.

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
