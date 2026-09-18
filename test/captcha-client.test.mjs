import assert from 'node:assert/strict';

const sitekey = 'public-test-sitekey';
const slots = [];
const scripts = [];
let resetId = null;

globalThis.window = {
  BRACKETS_CONFIG: { captchaSiteKey: sitekey },
  matchMedia: () => ({ matches: false }),
};
globalThis.document = {
  documentElement: { dataset: { theme: 'light' } },
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement() {
    const listeners = new Map();
    return {
      dataset: {},
      addEventListener(type, fn) { listeners.set(type, fn); },
      remove() {},
      fail() { listeners.get('error')?.(); },
    };
  },
  head: {
    append(script) {
      scripts.push(script);
      window.hcaptcha = {
        render(slot, options) {
          slots.push({ slot, options });
          options.callback('verified-token');
          return 17;
        },
        reset(id) { resetId = id; },
      };
      const callback = new URL(script.src).searchParams.get('onload');
      window[callback]();
    },
  },
};

const captcha = await import(`../lib/captcha.js?captcha-client=${Date.now()}`);
const slot = { isConnected: true, dataset: {} };
const scope = {
  querySelectorAll: () => [slot],
  querySelector: () => slot,
};

assert.equal(captcha.enabled(), true);
await captcha.mount(scope);
assert.equal(scripts.length, 1, 'the browser script is loaded lazily');
assert.match(scripts[0].src, /render=explicit/);
assert.match(scripts[0].src, /onload=__bracketsHcaptchaReady/,
  'explicit rendering waits for the provider ready callback');
assert.equal(slots[0].options.sitekey, sitekey);
assert.equal(captcha.token(scope), 'verified-token');
captcha.reset(scope);
assert.equal(resetId, 17);
assert.equal(captcha.token(scope), '');

console.log('PASS captcha client: lazy ready callback, public sitekey, token, and reset');
