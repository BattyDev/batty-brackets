'use strict';

import * as store from './lib/store.js';
import * as tour from './lib/tour.js';

store.boot({ demo: true });
tour.snapshot();

document.getElementById('reset-demo')?.addEventListener('click', () => {
  tour.clearProgress();
  store.reset();
  store.seedDemo();
  tour.snapshot();
  const status = document.getElementById('demo-reset-status');
  if (status) status.textContent = 'Sample data and tour progress reset.';
});

document.documentElement.dataset.demoReady = 'true';
