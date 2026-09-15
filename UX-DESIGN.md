# Player and host experience redesign

## Product decision

One tournament has two audiences with different priorities. Player and Host
are explicit, linkable experiences. A person can switch roles without losing
the selected event. This choice never grants permission or changes event data.
The venue display remains a third, dedicated surface for the room.

## Audience and information hierarchy

| Context | First question | Primary surface | Supporting detail |
| --- | --- | --- | --- |
| Player arriving | Where is my event? | Event list and join-by-code | Time, venue, game, entry count |
| Player entered | What do I do now? | Called/next set or preparation status | Entry checklist, signature, fee, check-in |
| Player competing | Who and where? | Large opponent name and station | Round, call timing, head-to-head |
| Player waiting/finished | What happens next? | Waiting, waitlist, or completion message | Bracket, recorded results, profile |
| Host preparing | Which event am I running? | Host event list with direct management links | Completed events in disclosure |
| Host at the venue | What needs attention? | Arrivals, occupied stations, bracket readiness | Actionable guidance and phase controls |
| Host operating | What can I do about it? | Roster, seeding, run, rules, settings | Existing bulk tools, undo, import preview |
| Venue audience | Who is playing? | Existing station and bracket broadcast | Queue, round, score, organizer |

## Navigation and interaction

- Player navigation: Events, Join event, My profile. Creating a tournament is
  available through Host rather than a floating action over player content.
- Host navigation: My events, Create event, Backups. Event-specific tools retain
  their existing URLs so bookmarks, tours, and operational actions keep working.
- The event mode switch preserves event context. Unknown event tab URLs now
  fall back to useful content with a corresponding selected navigation link.
- Event cards have separate valid links; no action button is nested in a link.
- Closed registration explains the state and offers the bracket rather than an
  entry action that cannot succeed. Waitlisted entries get explicit messaging.
- Demo entry points are audience-specific. They continue to operate the real
  application and restore the borrowed identity when the tour ends.
- Device-only storage and unavailable cross-device sharing remain explicit.

## Visual system

Bold system typography, violet primary controls, cool light/dark surfaces,
rounded cards, and consistent spacing replace the earlier newspaper layout.
The host desktop rail is deep navy; the player demo card uses a bright lime
call to action against violet. Semantic warnings retain their own colors.

Main body copy is 16px, supporting copy 14px, and eyebrow metadata 12px.
Large scores and opponent names carry the primary visual emphasis. Existing
Material tokens style shared tools; game identity stays inside game surfaces.
No external fonts, runtime dependencies, framework, or build step were added.
The original bracket mark anchors the navigation in a compact logo badge.
Player and host cards use controller and control-panel symbols from the existing
SVG icon set. Artwork stays geometric and functional; no generated scene images.


## Accessibility and responsive behavior

- Existing focus restoration, skip links, dialog focus handling, descriptive
  action labels, live clocks, and reduced-motion behavior are retained.
- Text uses explicit foreground/background role pairs, never opacity to dim it.
- Desktop uses a navigation rail; phones use bottom navigation. Lists stack,
  summary metrics compact, and operational tables preserve their scroll areas.
- Empty, signed-out, unregistered, waitlisted, waiting, active, eliminated, and
  completed player states have purposeful next steps.
- Browser suites check keyboard use, theme behavior, 200% reflow, target size,
  focus obstruction, contrast, operational flows, and route-specific navigation.

## Validation and remaining research

This redesign is based on the existing product, its recorded requirements,
and its regression suites. It is not a claim of observed user research.
Before a real event, test with players and hosts in a venue:

1. Can a first-time player find the event and explain their next action?
2. Can a player identify their opponent and station at a glance?
3. Can a host find missing arrivals, call a set, and correct a result unaided?
4. Does switching between playing and hosting preserve their mental context?
5. Are names and calls readable on the actual TV, at viewing distance?

Observe task completion, wrong turns, missed station calls, time to locate an
entrant, and time to correct a result. Keep backend activation, notifications,
payments, and player self-reporting under their existing product gates.

## Local-scene personality pass

The welcome experience now borrows from local tournament flyers: condensed
poster lettering, ticket-like event cards, dashed dividers, offset edges, and
a lime bat crest on a restrained dot pattern. No generated scene artwork.
Copy is grounded in playing sets and running a weekly local.

Host headings and summary panels carry the same identity with less decoration.
Body text, forms, scores, navigation labels, and warning semantics retain the
readable system type and existing interactions. Poster fonts use locally
available faces with system fallbacks; there are no font downloads.

Readability refinement: the product title and game abbreviations use medium-weight
system sans with open spacing. Condensed display type stays in secondary headings.
The large crest above the player callout has been removed; the navigation and
wordmark logos remain.

## Implementation completion

Setup has a visible step title and returns to the host workspace. Player
profiles use the same record-card treatment and explicitly label win rate.
Player names retain readable system type. On phones, the host event name stays
visible and all six operational tabs wrap into two rows. Demo onboarding stays
after the working content so the event and player record come first.
