/* Brackets · connection settings
 *
 * Split out of app.js so that pointing the page at a Supabase project is a
 * two-line edit rather than a diff against application code -- the same
 * arrangement as /fcevents/config.js.
 *
 * Production uses the public project endpoint and publishable key below.
 * Localhost intentionally leaves them blank so development and the browser
 * regression suite remain isolated from production data. With no url and key
 * the app runs entirely on the device: local storage, no
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
 * Both values are public by design and safe to commit. The url is an endpoint;
 * the publishable key only ever grants what RLS allows. Do NOT put a service
 * role key or the database password here -- those bypass RLS entirely.
 */
const production = ['battybrackets.com', 'www.battybrackets.com'].includes(location.hostname);
window.BRACKETS_CONFIG = production ? {
  url: 'https://bbqauqqymjxqcyurxmna.supabase.co',
  key: 'sb_publishable_0wB8tbr7yclMFE3uXqJblg_-etHxkiL',
  /* Public sitekey only. The matching secret lives in Supabase Auth. */
  captchaSiteKey: '565e9866-a23e-4fc8-a2c0-419c881c62c4',
} : { url: '', key: '' };
