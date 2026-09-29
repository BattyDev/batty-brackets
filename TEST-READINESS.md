# Three-view tester readiness

## Latest repair pass — September 29, 2026

The review findings are repaired locally: event polling redraws when player
result submissions or withdrawals change without an event revision bump;
interrupted withdrawals become retryable after reload with the same request
ID; the reporting browser check uses separate demo and connected contexts.
The focused reporting, live-refresh, and match-submission checks passed. The
refresh check now authenticates its mock host, observes both pending-request
panels without a host interaction, and waits synchronously on actual store
state. The withdrawal check covers reload, ID reuse, and repeated taps.

`node test/run.mjs` passed **29/29 suites, zero skipped**, using installed
Chrome. The backend static-contract check and `git diff --check` also passed.
These are local/mocked results; no live-server acceptance is claimed.

**Connected pilot remains blocked.** The connected Supabase account lists no
dedicated staging project, and the Batty Brackets project has no development
branches. Staging creation awaits the user's organization choice and the
provider-required cost confirmation. No hosted migrations, authentication
configuration, independent-client live checks, deployment, or production
changes were performed. `backend/STAGING.md` now includes migration 108, and
`TESTER-SCRIPT.md` includes the two repaired player-request paths.

The dated sections below preserve earlier evidence; this repair pass supersedes
their outstanding reporting-test finding.

Reviewed September 28, 2026 against this checkout, including its existing
uncommitted work. This is a prototype preparation plan, not a production signoff.
Assumption: next week's target is independent host, player, and TV devices.

## Verdict

The local tournament workflow is substantial enough to test now. Connected host
save recovery, event refresh, player match submission, and withdrawal now have
provisional code checkpoints, but still need live-server acceptance. A polished local demo must not be presented as proof
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
   Walk-up group, source, and desk check-in fields now enter this same
   retryable save path; the focused boundary check also covers a rejected
   walk-up save, a subsequent read, retry, and accepted server read.

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
   remain unverified. A follow-up route-swap check holds event A's read open,
   navigates to event B, and verifies B continues polling without overlapping
   reads for the same event. Event refresh and hydration now share per-event
   in-flight reads, so a slow old route does not pause the current route.

3. **Finish the small player workflow.**
   `views/event.js` has joining, check-in, documents, and opponent/station
   information. Match scoring is currently a host operation in
   `views/admin.js`; `views/report.js` is content moderation, not match scoring.
   At the original review, there was no player match-result submission or
   withdrawal command in the inspected client boundary.

   Recommended cheap pilot policy: a player submits the winner and score; the
   host accepts or corrects it before the bracket advances. Defer a generalized
   dispute/trust system. Withdrawal before seeding removes the entry; after
   seeding it needs an explicit host-visible forfeit policy, not silent bracket
   deletion. Server commands must verify the caller owns the entry/match action.

   Use explicit sending, accepted, and failed/retry states. A failed request
   must preserve the entered choice; repeated taps/retries must not duplicate
   a result. Leave profile upgrades optional rather than automatically opening
   the current post-join upsell (`views/home.js:449`).

   **Provisional task 3 checkpoint (September 28):** Connected players can
   submit a called match's winner and score. The server checks match entry
   ownership and stale/completed state, stores one pending proposal per match,
   and returns the same proposal for an identical retry. The host Run view
   accepts or corrects the score through a versioned review command before
   bracket advancement; manual reporting remains available. The client keeps
   a failed choice for retry and displays the server's pending/accepted/
   corrected status. Focused backend-contract, mocked-store, bracket, mobile
   player, and host-operations checks passed. SQL execution, live-server
   acceptance, and manual cross-device verification remain blocked without a
   disposable staging backend. Withdrawal and optional post-join upgrade are
   separate follow-up work.

   **Provisional task 4 checkpoint (September 28):** Connected players can
   withdraw their own entry before bracket generation; the server removes the
   entry while retaining player and signed-document history. Once a bracket
   exists, the server records one pending request for the host. The Run view
   shows it and uses the existing DQ control on a ready set; the request stays
   pending across double-elimination sets until the player is out. Each DQ
   advances the opponent through the bracket engine.
   Local client, static SQL contract, mocked-backend, bracket, mobile player,
   and host-operations checks passed. SQL execution, live-server acceptance,
   and manual cross-device verification remain unverified without disposable
   staging. The automatic post-join upgrade interruption is resolved by task 6 below.

4. **Separate the demo and trim initial mobile loading.**
   **Provisional task 5 checkpoint (September 28):** `demo.html` now offers
   Host, Player, and TV entry links, a sample reset, and a return to the real
   app. The same application views run with a dedicated demo storage namespace;
   demo mode skips backend and real-auth initialization. Tour progress and TV
   preferences are demo-scoped, and the player tour's borrowed identity stays
   in that store. Normal event work no longer seeds samples or shows tours.
   Ordinary boot removes only rows marked as legacy demo data, their generated
   brackets, and a legacy borrowed demo session while preserving real events
   and a real session.

   Focused local browser checks passed for all three entry paths, all three
   tours, reset isolation, legacy-cache cleanup, normal-app no-seed behavior,
   and the existing local, flow, and tour-card stability checks. Mock project
   configuration confirmed the demo path did not request the Supabase client.
   Manual verification was skipped; no disposable staging backend was
   configured, so this is not live-server evidence.

   **Provisional task 6 checkpoint (September 28):** The host editor, setup,
   TV, and recovery views now load on their own routes. Direct hash links and
   delegated actions remain in use; lazy routes show a loading message and a
   retry action if a module request fails. A pending setup publish draft still
   resumes after an OAuth return without loading the wizard on ordinary visits.
   The phone event desk focuses on entry, required consent/check-in, current or
   next opponent and station, result submission, and withdrawal. Rules and the
   full bracket remain secondary links; the automatic account-upgrade dialog
   after joining is gone.

   Focused local Edge browser checks passed for player join, consent and
   check-in at 390px and 320px, plus setup, recovery, TV, roster, host
   operations, and event flows. A one-time failed recovery module request
   showed the retry state and recovered on retry. Manual verification was
   skipped; no disposable staging backend was configured, so this is not
   live-server evidence.

   **Provisional task 7 checkpoint (September 28):** A disposable 100-entrant,
   255-match double-elimination event with five stations was exercised locally.
   The host called a match and reported its result; separate phone and TV
   browser contexts read the acknowledged mock snapshots, with the TV seeing
   the call on its next five-second poll. This surfaced a connected-route
   redraw bug: a synthetic `hashchange` from a local edit discarded completed
   hydration and briefly replaced the host view with a loading screen. The
   router now clears hydration only when the URL actually changes, and the
   mocked-save regression confirms the station stays visible before server
   acknowledgment. Run also surfaces six recent completed results with a
   direct correction action; the focused browser check confirmed it is visible
   near the top of the first viewport and opens the existing correction flow.
   `node test/run.mjs operations roster tv live-refresh` passed all four
   selected suites with installed Chrome. No live backend or manual
   cross-device verification was used; connected acceptance remains
   unverified.

## Performance evidence and limits

- Fresh localhost player arrival at 390px, measured before and after task 6
  with browser resource timings: **26 JS resources / 711,396 decoded JS bytes**
  and **28 same-origin resources / 824,337 decoded bytes** before; **21 JS
  resources / 489,910 decoded JS bytes** and **23 same-origin resources /
  602,851 decoded bytes** after. That is five fewer fetched resources and
  221,486 fewer decoded bytes (31% less JS, 27% less overall). This is local
  decoded size, not compressed production transfer or cellular latency.
- A disposable 100-entrant local demo generated 255 bracket matches. Five
  repeated desktop run-view draws at 1440px measured **47.8–57.2 ms** on this
  computer. This measures rendering work, not first paint or server saves.
- Task 7's 100-entrant local exercise measured roster searches at **4.3–11.9
  ms**, full Run view redraws at **17.7–30.6 ms**, station call plus redraw at
  **46.2–74.3 ms**, and result save plus redraw at **51.7 ms**. A connected
  mock snapshot serialized to **119,523 bytes** (**119,611 bytes** with the
  modeled RPC envelope). One mocked run observed **107–110 ms** from a host
  save to store acknowledgment; the independent TV showed the call after its
  next poll at about **5.05 seconds**. These are local samples using an
  in-memory mock, not live-server timing or a concurrency result.
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

The player workflows from priorities 3 and 4 now have local and mocked
coverage. Use [TESTER-SCRIPT.md](TESTER-SCRIPT.md) for the connected pilot
sequence. Until a disposable staging backend and staging app URL are provided,
live acceptance remains blocked. No production deployment or live-server
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

- **Task 5 focused checks (September 28):** `node test/run.mjs tours`, `node
  test/run.mjs local stability`, and `node test/run.mjs flows` each passed with
  installed Chrome; zero selected suites were skipped. These are local browser
  checks. The demo's configured-project boundary used a fake project config
  and blocked CDN client request; no backend or production write was involved.

Existing suites exercise local and mocked flows; a green run does not cover
the missing workflows above or validate production RPC deployment. This
September 28 follow-up changed the walk-up save and event refresh paths. The
focused `node test/run.mjs connected-boundary live-refresh` run passed with
installed Chrome; no live backend or manual cross-device verification was
used.

## Integrated tester-readiness pass — September 29, 2026

**Assessment: not ready for a connected pilot.** The active checkout has no
disposable staging endpoint configured. `config.js` leaves the local endpoint
and key blank, and the process has no staging Supabase URL/key. The public
production endpoint is selected only on the production hostname and was not
used. Independent-client live checks and manual verification were not run.

| Check | Outcome | Evidence and scope |
|---|---|---|
| Full existing suite, `node test/run.mjs` | **Failed: 26/29 passed; 0 skipped** | One integrated local browser/Node run with installed Chrome. Two failures were stale wait conditions: the guest signup assertion waited for a load event after a same-page hash change, and the tour assertion accepted the lazy-route placeholder as a loaded view. After tightening those existing checks, `node test/browser/brand.test.mjs` passed **63/63** and `node test/browser/tours.test.mjs` passed **44/44**. `browser/reporting.test.mjs` remains a local failure at its demo connected-scope probe (`The isolated demo cannot connect to a server`); it is outside this pilot's requested workflows. No full-suite rerun was done. |
| Backend static-contract check, `node test/backend/contract-static.test.mjs` | **Passed** | Ran once after a scoped execution fallback: migration order, RPC parity, fixed search paths, admin AAL2 boundary, and private moderation data passed. |
| Connected independent host/player/TV validation | **Blocked** | No disposable staging project or staging app URL is configured. Localhost is device-only; production was not used. |
| Manual tester verification | **Not run** | Skipped as previously requested; no manual result is claimed. |

No application-code fix was needed. The two pilot-relevant failures came from
existing browser checks that did not wait for the completed client-side route;
their stricter targeted reruns passed. The reporting failure was not changed
because that moderation workflow is outside this request. Use TESTER-SCRIPT.md
against a disposable staging environment before reassessing connected-pilot
readiness.
