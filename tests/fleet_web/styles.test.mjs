// Every class the screens use has a style in index.html (a removed block of
// CSS once took other screens' styles with it). Classes that are only hooks
// for the code, or built from a variable, are listed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const HOOKS = new Set(['day-card', 'share-body', 'pay-list', 'tone-']);

test('each class in app.js has a CSS rule', () => {
  const js = fs.readFileSync(new URL('../../fleet/js/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../../fleet/index.html', import.meta.url), 'utf8');
  const names = new Set();
  for (const m of js.matchAll(/class="([^"$]*)/g)) for (const c of m[1].split(/\s+/)) if (/^[a-z][a-z0-9-]+$/.test(c)) names.add(c);
  assert.ok(names.size > 100);
  const missing = [...names].filter((c) => !HOOKS.has(c) && !new RegExp(`\\.${c}(?![a-z0-9-])`).test(css));
  assert.deepEqual(missing, []);
});
