import { html, raw } from '../lib/ui.js';

const content = `

    <section class="help-hero">
      <h1>Your local. One clear next step.</h1>
      <p>Batty Brackets helps fighting-game communities register players, manage check-in, and run tournament brackets and stations. Hosts run the room. Players join, find their next set, and send results to the host.</p>
      <nav class="help-jumps" aria-label="Help topics"><a class="btn btn-filled" href="#/about/player">I’m playing</a><a class="btn btn-outlined" href="#/about/host">I’m hosting</a><a class="btn btn-text" href="#/about/faq">Common questions</a></nav>
    </section>
    <div class="help-grid">
      <section class="help-box" id="player">
        <h2>I’m playing</h2>
        <ol>
          <li><b>Open the host’s link or scan their flyer.</b> You can also enter the event code on the Join screen.</li>
          <li><b>Check the event details and enter.</b> Confirm the game, date, venue, fee, and whether you are admitted or waitlisted. You can join as a guest using a nickname.</li>
          <li><b>Follow your next task.</b> Review any required documents, then check in when the host opens it and you are present.</li>
          <li><b>Keep My event handy.</b> Your opponent and station appear there when the host calls your set.</li>
          <li><b>Send the result after you play.</b> Enter the winner and scores. The host reviews it before the bracket advances.</li>
        </ol>
        <p>If the host entered you at the desk, ask how to access that entry before joining again. This helps avoid duplicate records.</p>
        <a class="btn btn-filled" href="#/join">Join an event</a>
      </section>
      <section class="help-box" id="host">
        <h2>I’m hosting</h2>
        <ol>
          <li><b>Create an event from the host desk.</b> Choose the game, format, venue, date, capacity, stations, fee, and rules. Review the preset for your local.</li>
          <li><b>Prepare registration.</b> Add the actual text of any required documents. Choose Listed or Unlisted, then share the signup link or code.</li>
          <li><b>Work the door.</b> Review the roster, waitlist, documents, and payment records. Add walk-ups during Registration or Check-in. Required documents must be reviewed before check-in. For a player handoff, keep the entry unused and open Registration before they claim.</li>
          <li><b>Open check-in and review the field.</b> Check who is present, choose who to seed, adjust the order, and review projected pairings.</li>
          <li><b>Generate and run the bracket.</b> Call sets to stations, accept or correct results, and use the venue display to show the room what is happening.</li>
        </ol>
        <p>Desktop gives you the full workspace. A phone is useful for checking arrivals and handling individual station actions.</p>
        <a class="btn btn-outlined" href="#/host">Open the host desk</a>
      </section>
    </div>
    <section class="use-cases">
      <h2>What can I use it for?</h2>
      <p>A weekly at an arcade, a club tournament, a community meetup, or a local bracket at a larger gathering. Each event has its own game, rules, roster, and stations. For a night with multiple games, create a separate event for each bracket.</p>
      <p>The game is played on your setup; Batty Brackets coordinates the tournament around it. The host decides the local rules, payment method, attendance policy, and required documents.</p>
    </section>
    <aside class="payment-note" id="payments" aria-label="How entry fees work">
      <h2>Entry fees are paid to the host</h2>
      <p>The host sets the amount, collects payment at the venue or using the method they provide, and records what you paid. Batty Brackets tracks the amount due and received. It does not take a card payment, collect money, or send a refund.</p>
    </aside>
    <section class="faq" id="faq">
      <h2>Common questions</h2>
      <details id="guest"><summary>Do I need an account to play?</summary><p>You can start with a guest nickname. Keep using the same browser session for that entry. Saving your guest record to an account helps you return to it later. If the host already added you, ask them which entry to use before creating another one.</p></details>
      <details id="code"><summary>Where do I get an event code?</summary><p>From the host, their flyer, or the event announcement. A signup link opens the matching event directly. If the code does not work, check it with the host; the invite may no longer be available. An unlisted event may not appear in the directory.</p></details>
      <details id="check-in"><summary>I joined. Why am I not checked in?</summary><p>Registering saves your place; checking in confirms you are present. The host must open check-in, and you must complete any required documents first. Follow the next task on My event. A waitlisted entry is still waiting for admission.</p></details>
      <details id="documents"><summary>Why does the site ask me to read a document?</summary><p>The host may require event rules, a venue notice, or another document before check-in. Read the displayed text before acknowledging it. If a document changes, you may need to review the new version. If the text is missing, incorrect, or unclear, ask the host.</p></details>
      <details id="waitlist"><summary>What does waitlisted mean?</summary><p>The event has reached its admission cap. Your interest is recorded, but you do not yet have a place in the bracket. Ask the host about available places and whether you should pay while waiting. Waitlisted entries are excluded from seeding until admitted.</p></details>
      <details id="paid"><summary>I paid, but the site still says I owe money. What should I do?</summary><p>Ask the host to update your entry’s payment record. Only the host records the amount received. A partial payment leaves a remaining balance; a waived entry can have a charge of zero. Paying outside the site does not update the record automatically.</p></details>
      <details id="match"><summary>Where do I find my opponent and station?</summary><p>Open your event in Player view and stay on My event. When called, it shows the station, opponent, round, and any arrival deadline. Before the bracket or opponent is ready, the page shows a waiting state. Ask the host if you cannot find your assignment.</p></details>
      <details id="result"><summary>I sent a result. Why hasn’t the bracket moved?</summary><p>A player submission is a result for the host to review. It does not advance the bracket until the host accepts or corrects it. Look for the sent or accepted status on My event. If the score is wrong, tell the host so they can correct it.</p></details>
      <details id="leave"><summary>How do I leave an event?</summary><p>Use Withdraw from event and read the confirmation. Before bracket generation, withdrawal removes your entry. Once a bracket exists, it sends a request to the host; you remain in the bracket until the host records the appropriate DQ or forfeit. Completed results remain.</p></details>
      <details id="walkup"><summary>The host entered me at the desk. Can I take over that record?</summary><p>Coordinate with the host before making another entry. Use the complete claim link the host shares; it expires after 24 hours. Claim while Registration is open, before check-in, signing documents, seeding, or play. You must not already be entered in that event. After claiming, review documents and check in. Used entries and played history cannot transfer automatically; ask the host for help.</p></details>
      <details id="unlisted"><summary>Does Unlisted make an event private?</summary><p>Unlisted hides the event from the directory. Anyone with its code or link can still open it. Share the link with that in mind; unlisted is not the same as a secret or invitation-only event.</p></details>
      <details id="connection"><summary>What if the venue connection drops?</summary><p>Check whether the site says Saved, Sending, or that delivery was not confirmed. Reconnect and review the saved state before repeating an action. Do not assume an entry, result, or withdrawal reached the host just because you entered it. If you are unsure, speak to the host.</p></details>
      <details id="seeding"><summary>As a host, who should I include when seeding?</summary><p>Review admitted entrants and attendance first. Choose all admitted entrants or only those checked in, according to your event policy. Waitlisted players are excluded. Review byes and seed order before generating; generating also starts matches.</p></details>
      <details id="backup"><summary>Can I export my event?</summary><p>Event settings provide an entrants CSV and an event JSON export. The host workspace also has Backups. Export before replacing a bracket or making a major event change, and use the backup guidance to understand what you are restoring.</p></details>
      <details id="appearance"><summary>Can I change the look without changing an event?</summary><p>Options lets you choose your ink, heading lettering, and light or night paper. These are personal appearance preferences on the device. They do not change another player’s fee, rules, or bracket.</p></details>
      <details id="demo"><summary>Can I try it before hosting?</summary><p>Yes. The sample demo has host, player-record, and venue-display views. Its data and sign-in are separate from real events. Demo changes stay on the device and can be reset.</p></details>
    </section>
    <footer class="help-foot"><a href="#/">Back to events</a><a href="./demo.html">Explore the sample demo</a><a href="#/about/player">Player quick start</a><a href="#/about/host">Host quick start</a></footer>
  `;

export function view(ctx) {
  return { title: 'About & help', back: '/', body: html`<div class="pane about-page">${raw(content)}</div>`, afterRender: () => {
    const topic = ctx.params.topic;
    if (!topic) return;
    requestAnimationFrame(() => {
      const target = document.querySelector('.about-page #' + CSS.escape(topic));
      if (target?.tagName === 'DETAILS') target.open = true;
      target?.scrollIntoView({ block: 'start' });
    });
  } };
}
