// Change password: checks before anything is sent, and Supabase's messages.
import assert from 'node:assert/strict';
import test from 'node:test';

import { passwordError, passwordProblem } from '../../ledger/js/password.js';

test('passwordProblem checks what was typed', () => {
  assert.match(passwordProblem('', 'abcdefgh', 'abcdefgh'), /current/);
  assert.match(passwordProblem('old-pass', '', ''), /new password/);
  assert.match(passwordProblem('old-pass', 'short', 'short'), /at least 8/);
  assert.match(passwordProblem('old-pass', 'new-pass-1', 'new-pass-2'), /don't match/);
  assert.match(passwordProblem('same-pass', 'same-pass', 'same-pass'), /same/);
  assert.equal(passwordProblem('old-pass', 'new-pass-1', 'new-pass-1'), '');
});

test('passwordError puts Supabase messages in plain words', () => {
  assert.equal(passwordError('Invalid login credentials'), 'The current password is wrong.');
  assert.match(passwordError('New password should be different from the old password.'), /same/);
  assert.match(passwordError('Failed to fetch'), /No internet/);
  assert.equal(passwordError('Something else'), 'Something else');
});
