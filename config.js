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
 * To connect it:
 *
 *   1. Run brackets/sql/001_schema.sql against the `battydevsite` project --
 *      the same shared project /fcevents uses. Every object it creates is
 *      prefixed `bkt_` for exactly that reason.
 *   2. Enable the Discord provider in Auth > Providers, with the redirect URL
 *      https://battydev.com/brackets/ and scopes `identify email`.
 *   3. Fill in the two values below.
 *
 * Both values are public by design and safe to commit. The url is an endpoint;
 * the publishable key only ever grants what RLS allows. Do NOT put a service
 * role key or the database password here -- those bypass RLS entirely.
 */
window.BRACKETS_CONFIG = {
  url: '',
  key: '',
};
