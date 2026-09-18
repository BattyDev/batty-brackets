/* Brackets · hCaptcha
   ===========================================================================
   hCaptcha is loaded only when a protected form is actually visible. That
   keeps the normal bracket/venue screens dependency-free and avoids spending
   bandwidth on the challenge script for people who are already signed in.

   The sitekey is public browser configuration. The secret never belongs in
   this repository; Supabase stores it and performs server-side verification.
   =========================================================================== */

'use strict';

const widgets = new WeakMap();
let scriptPromise = null;
const READY_CALLBACK = '__bracketsHcaptchaReady';

function siteKey() {
  return String(window.BRACKETS_CONFIG?.captchaSiteKey || '').trim();
}

export function enabled() {
  return Boolean(siteKey());
}

function loadScript() {
  if (window.hcaptcha?.render) return Promise.resolve(window.hcaptcha);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-brackets-hcaptcha]');
    const script = existing || document.createElement('script');
    const cleanCallback = () => {
      try { delete window[READY_CALLBACK]; } catch { window[READY_CALLBACK] = undefined; }
    };
    const failed = (error) => {
      cleanCallback();
      scriptPromise = null;
      if (script.dataset.bracketsHcaptcha) script.remove();
      reject(error);
    };

    window[READY_CALLBACK] = () => {
      if (!window.hcaptcha?.render) {
        failed(new Error('hCaptcha loaded without its browser API.'));
        return;
      }
      cleanCallback();
      resolve(window.hcaptcha);
    };
    script.addEventListener('error', () => failed(new Error('Could not load the anti-bot check.')), { once: true });
    if (!existing) {
      script.src = `https://js.hcaptcha.com/1/api.js?render=explicit&onload=${READY_CALLBACK}`;
      script.async = true;
      script.defer = true;
      script.dataset.bracketsHcaptcha = '1';
      document.head.append(script);
    }
  });
  return scriptPromise;
}

export async function mount(scope = document) {
  if (!enabled()) return;
  const slots = [...scope.querySelectorAll('[data-hcaptcha-widget]')]
    .filter((slot) => !widgets.has(slot));
  if (!slots.length) return;

  try {
    const api = await loadScript();
    for (const slot of slots) {
      if (!slot.isConnected || widgets.has(slot)) continue;
      const id = api.render(slot, {
        sitekey: siteKey(),
        theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
        size: window.matchMedia?.('(max-width: 360px)').matches ? 'compact' : 'normal',
        callback: (token) => { slot.dataset.captchaToken = token; },
        'expired-callback': () => { delete slot.dataset.captchaToken; },
        'error-callback': () => { delete slot.dataset.captchaToken; },
      });
      widgets.set(slot, id);
    }
  } catch (error) {
    for (const slot of slots) {
      if (!slot.isConnected) continue;
      slot.dataset.captchaError = '1';
      slot.textContent = error.message || 'Could not load the anti-bot check.';
    }
  }
}

export function token(scope) {
  if (!enabled()) return undefined;
  const slot = scope?.querySelector?.('[data-hcaptcha-widget]');
  return String(slot?.dataset?.captchaToken || '').trim();
}

export function reset(scope) {
  const slot = scope?.querySelector?.('[data-hcaptcha-widget]');
  const id = slot && widgets.get(slot);
  if (slot) delete slot.dataset.captchaToken;
  if (id === undefined || !window.hcaptcha?.reset) return;
  try { window.hcaptcha.reset(id); } catch { /* the form may already be gone */ }
}
