# Tōkon local rehearsal

This is a dry run on one device. Use a disposable browser profile or reset
only the rehearsal data afterward. Do not use the demo as the event: create a
new event and enter the real rehearsal values below.

## Before opening the wizard

Write down the values the organiser actually intends to use:

| Value | Enter |
|---|---|
| Event name | ______________________________ |
| Start date/time | ______________________________ |
| Venue | ______________________________ |
| Entrant capacity, if any | ______________________________ |
| Stations available | ______________________________ |
| Entry fee, if any | ______________________________ |

In the current build, `config.js` is unconfigured. The wizard therefore says
“Device-only sign-ups”: the event, roster, and bracket stay on this device.
Add entrants here and connect this computer to the venue TV; another phone
cannot join the event. The setup does not offer a visibility or invite-link
choice in this mode because those controls would not do anything.

## Create the rehearsal event

1. Open **New event**, choose **MARVEL Tōkon: Fighting Souls**, and enter the
   actual name, venue, start time, capacity, station count, and fee. Capacity
   is optional; station count is required for an offline event and must be the
   number of stations the room can really run.
2. On **Rules**, select the preset the organiser intends to rehearse. Every
   Tōkon preset is marked **Provisional**. Read the selected values and any
   changes; do not describe them to players as ratified community standards.
3. On **Sign-ups**, keep the code of conduct (and add any document the venue
   actually requires). On **Publish**, check **I reviewed the provisional
   rules for this event and accept them as the organizer**. The event is not
   created until the organiser presses publish and completes the device-account
   prompt.
4. Dismiss the created dialog only after confirming the event is on this
   device. Use **Add entrants** or **Paste a spreadsheet** from the organiser
   view. The setup-created station rows should equal the station count entered.

## Rehearsal script

Use at least eight disposable entrant records, plus one duplicate name/tag and
one walk-up. Give them obvious rehearsal tags so the results are not confused
with real players.

1. **No-shows at check-in.** Add the planned roster, then leave two entrants
   unchecked. Open the organiser dashboard and confirm the guidance explains
   how many are missing and contrasts re-seeding with running the bracket as-is.
   Use the entrant filter for people who are not checked in. Do not generate a
   bracket until the organiser chooses whether those entrants are dropped or
   kept as possible no-show DQs.
2. **Duplicate review.** Paste a small sheet containing the same rehearsal tag
   twice. Use the import preview, confirm the duplicate-in-file row is called
   out, and verify that committing the preview does not create two new people.
   Correct the sheet and import it again; the preview should say unchanged or
   update where appropriate.
3. **Late arrival / walk-up.** After check-in has started, use **Add one** for
   a late entrant. Enter their tag and optional team/venue, verify the entrant
   appears on the roster with a claim code, then decide whether to check them
   in before seeding. If capacity is full, confirm the normal roster path marks
   overflow waitlisted instead of silently replacing somebody.
4. **Seed and generate.** Seed the checked-in field in the seeding lab, inspect
   the separation/projection explanation, and use the move buttons for one
   deliberate adjustment. Generate the double-elimination bracket only after
   the organiser accepts the displayed order. The current UI is a single
   bracket flow; pools → top cut is not implemented, so do not rehearse it as
   though the pool-count option existed.
5. **Score correction.** Call a set, report an intentionally wrong score, and
   confirm the winner advances. Activate the completed match again, correct the
   score, and verify the downstream bracket is rebuilt from the correction. For
   an already complete set, use **Un-report this set** when the right rehearsal
   is to clear it entirely; the old result remains in the log.
6. **DQ.** Call another ready set and leave it until the displayed DQ window
   passes, or use the report dialog immediately for a controlled rehearsal.
   Use **Disqualify** for the absent player and confirm the opponent advances
   and the station is available for the next set. Check that the timer uses the
   selected Tōkon preset’s DQ value.
7. **Grand-final reset.** Continue the double-elimination bracket until the
   first Grand Final. Have the losers-side entrant win that first final. Confirm
   **Grand Final (reset)** becomes the live next set, then report it and confirm
   the event completes. Repeat with a fresh rehearsal if needed to verify the
   other branch: a winners-side win cancels the reset instead of creating an
   unnecessary extra set.

## Exit checklist

- The organiser can identify every no-show, duplicate, late entrant, and
  waitlisted entrant from the roster.
- The TV is showing the organiser’s device, not promising another-device join.
- The selected Tōkon rules are still labelled provisional and were explicitly
  reviewed before creation.
- The station count matches the room, a correction is recoverable, a DQ
  advances the opponent, and both grand-final outcomes behave as expected.
- Reset or discard only the disposable rehearsal data. Do not deploy, push, or
  connect a production backend as part of this rehearsal.
