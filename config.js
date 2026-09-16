/* Brackets · connection settings
 *
 * Split out of app.js so that pointing the page at a Supabase project is a
 * two-line edit rather than a diff against application code -- the same
 * arrangement as /fcevents/config.js.
 *
 * BLANK ON PURPOSE, for now.
 *
 * With no url and key the app runs entirely on the device: local storage, no
 * network, no account. That is a legitimate mode and not a degraded one -- a
 * TO running a 16-person weekly off one phone genuinely does not need a
 * server, and the app says so plainly in the corner ("On this device") rather
 * than pretending to be signed in to something.
 *
 * It also means the demo data in data/demo.js seeds itself, so opening the
 * page shows a working tournament instead of an empty state. The moment a
 * project is named below, demo seeding stops: an account with a real backend
 * must look empty when it is empty.
 *
 * Do not connect this file to a project yet. The historical
 * sql/001_schema.sql has known authorization and identity defects and must not
 * be applied. Connected mode is released only after all of these gates pass:
 *
 *   1. Apply sql/staging/ to a dedicated empty staging project and run every
 *      adversarial database test in test/backend/.
 *   2. Complete the explicit lib/backend.js integration. Never attach the
 *      legacy store's generic outbox to the staging tables or auto-upload a
 *      device/demo event.
 *   3. Rehearse one event from separate organiser, player-phone and TV browser
 *      contexts, including sign-out, reconnect and capacity races.
 *   4. Review a production migration and rollback plan, then fill in only the
 *      two public values below.
 *
 * Both values are public by design and safe to commit. The url is an endpoint;
 * the publishable key only ever grants what RLS allows. Do NOT put a service
 * role key or the database password here -- those bypass RLS entirely.
 */
window.BRACKETS_CONFIG = {
  url: '',
  key: '',
};
