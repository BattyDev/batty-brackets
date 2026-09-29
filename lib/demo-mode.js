/* Explicit demo entry detection and browser-preference namespacing. */

'use strict';

export function isDemoMode() {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1'
      || window.location.pathname.endsWith('/demo.html');
  } catch { return false; }
}

export function scopedBrowserKey(key) {
  return isDemoMode() ? `${key}.demo` : key;
}
