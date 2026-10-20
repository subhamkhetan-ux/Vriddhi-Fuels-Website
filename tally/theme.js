/* Only appearance is persisted; voucher data and authentication are untouched. */
(function () {
  'use strict';
  var key = 'vriddhi-tally-theme';
  var modes = ['dark', 'light', 'auto'];
  var mode = 'dark';
  var system = window.matchMedia('(prefers-color-scheme: light)');
  try { var saved = localStorage.getItem(key); if (modes.indexOf(saved) !== -1) mode = saved; } catch (_) {}
  function apply() {
    var resolved = mode === 'auto' ? (system.matches ? 'light' : 'dark') : mode;
    document.documentElement.dataset.theme = resolved;
    document.querySelector('meta[name="theme-color"]').content = resolved === 'light' ? '#f5f5f7' : '#1c1c1e';
    var button = document.getElementById('btnTheme');
    if (!button) return;
    var label = mode.charAt(0).toUpperCase() + mode.slice(1);
    var next = modes[(modes.indexOf(mode) + 1) % modes.length];
    document.getElementById('themeLabel').textContent = label;
    button.title = label + ' theme · switch to ' + next;
    button.setAttribute('aria-label', label + ' theme. Switch to ' + next + ' theme');
  }
  apply();
  document.addEventListener('DOMContentLoaded', function () {
    apply();
    document.getElementById('btnTheme').addEventListener('click', function () {
      mode = modes[(modes.indexOf(mode) + 1) % modes.length];
      try { localStorage.setItem(key, mode); } catch (_) {}
      apply();
    });
  });
  if (system.addEventListener) system.addEventListener('change', function () { if (mode === 'auto') apply(); });
})();
