# Connected pilot tester script

## Environment and limits

**Connected pilot status: blocked.** There is no disposable staging backend or
staging app URL configured in this checkout. Do not use production data or
`https://battybrackets.com` for this test.

For local UI rehearsal only, run `python -m http.server 8000` from the
`batty-brackets/` checkout and open:

- App: `http://localhost:8000/`
- Isolated demo: `http://localhost:8000/demo.html`

The local app has no backend URL/key. Local and mocked checks cannot verify
account signup against Supabase, authorization, or sync between devices. Before
the connected run, the pilot owner must provide a dedicated disposable staging
project and app URL, apply the current reviewed staging migrations, configure
the public staging client URL/publishable key, and enable the required staging
auth settings. Never put a service-role key in the browser config.

Use disposable names and test contact details. Keep the host on a desktop,
each player in a separate phone/browser session, and TV in a separate browser
or device. Do not share local storage between these clients. Record the staging
app URL, build/commit, device/browser, time, and a pass/fail note for each step.

## Steps

1. **Signup and check-in:** From the host, create a disposable event and open
   its invite on two separate player sessions. Join as a guest with a unique
   nickname; tap Join twice and confirm there is one entry and capacity is
   respected. Move to check-in, check in from the player's session, refresh,
   and confirm the host sees the arrival.
2. **Station call and reconnect:** Seed the event and call a match to a station.
   Leave player and TV views open; both should update within 10 seconds.
   Disconnect one player session, restore its network, and confirm its match
   and station refresh without duplicate actions.
3. **Result, approval, and correction:** Submit the winner and score from a
   player's match screen. Leave the host untouched and confirm it shows the
   pending request within 10 seconds. Approve it and confirm
   the bracket advances on all views. Correct that result from the host Run
   view and confirm bracket and station assignments update everywhere.
4. **Withdrawal and completion:** Withdraw one entry before seeding and
   confirm it leaves the admitted roster. Request withdrawal from another
   entry after play starts; confirm the host resolves it through the ready-set
   DQ action without leaving the opponent stuck. Also interrupt a withdrawal
   while sending, reload the player page, reconnect, and retry; confirm one
   request appears and the player is not stuck in Sending. Play through the final,
   including a grand-final reset if required, and confirm every view shows the
   completed state.
5. **Demo isolation:** Open `/demo.html`, enter Host, Player, and TV, then reset
   the sample. Return to the real event and confirm its event, entries, and
   signed-in player session are unchanged. The demo should remain local and
   make no server writes.

## Record

Mark each step **PASS**, **FAIL**, or **BLOCKED** with a short note. Stop the
connected run if the app URL points at production, a player can act on another
player's entry, a failed action is presented as accepted, or a retry duplicates
an entry/result. Local rehearsal outcomes must be labeled local; they do not
clear the connected-pilot blocker.
