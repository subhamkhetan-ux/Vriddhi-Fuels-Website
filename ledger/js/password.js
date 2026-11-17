// Change password (the top bar's Password button): what's wrong with what
// was typed, before anything is sent. '' when it's fine.
export const MIN_PASSWORD = 8;
export function passwordProblem(current, next, confirm) {
  if (!current) return 'Type your current password.';
  if (!next) return 'Type the new password.';
  if (next.length < MIN_PASSWORD) return `The new password needs at least ${MIN_PASSWORD} characters.`;
  if (next !== confirm) return 'The two new passwords don\'t match.';
  if (next === current) return 'The new password is the same as the current one.';
  return '';
}

// Supabase's messages in plain words
export function passwordError(message) {
  const m = String(message || '');
  if (/invalid login credentials/i.test(m)) return 'The current password is wrong.';
  if (/different from the old password/i.test(m)) return 'The new password is the same as the current one.';
  if (/at least|too short|weak/i.test(m)) return `Supabase says the new password is too weak: ${m}`;
  if (/reauthenticat|nonce/i.test(m)) return 'Supabase wants an emailed code before changing the password (Secure password change is on). Change it from the SQL Editor instead, or turn that setting off under Authentication → Providers → Email.';
  if (/failed to fetch|network/i.test(m)) return 'No internet connection — nothing was changed. Try again.';
  return m || 'The password could not be changed.';
}
