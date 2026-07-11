// Auth views: login, setup, forced password change, and the change-password modal.
import { api, friendlyError } from '../api.js';
import { $, toast, openDialog, closeDialog } from '../ui.js';

function strengthLabel(pw) {
  if (!pw) return '';
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^a-zA-Z0-9]/.test(pw)) score++;
  if (pw.length < 10) return 'Too short (min 10 characters)';
  return ['', 'weak', 'okay', 'good', 'strong', 'strong'][score] ? `Strength: ${['', 'weak', 'okay', 'good', 'strong', 'strong'][score]}` : '';
}

let cb = { onLoggedIn: () => {} };

export function initAuth(callbacks) {
  cb = callbacks;

  // Setup
  $('#setup-pass').addEventListener('input', (e) => { $('#setup-strength').textContent = strengthLabel(e.target.value); });
  $('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#setup-user').value.trim().toLowerCase();
    const password = $('#setup-pass').value;
    const confirm = $('#setup-confirm').value;
    const errEl = $('#setup-error'); errEl.textContent = '';
    if (password !== confirm) { errEl.textContent = 'Passwords do not match.'; return; }
    const btn = e.submitter; btn.disabled = true; btn.classList.add('loading');
    const res = await api.post('/api/setup', { username, password });
    btn.disabled = false; btn.classList.remove('loading');
    if (res.ok) cb.onLoggedIn();
    else errEl.textContent = friendlyError(res.data, 'Setup failed');
  });

  // Login
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#login-user').value.trim().toLowerCase();
    const password = $('#login-pass').value;
    const errEl = $('#login-error'); errEl.textContent = '';
    const btn = e.submitter; btn.disabled = true; btn.classList.add('loading');
    const res = await api.post('/api/login', { username, password });
    btn.disabled = false; btn.classList.remove('loading');
    if (res.ok) { $('#login-pass').value = ''; cb.onLoggedIn(); }
    else if (res.status === 429) {
      const secs = Number(res.data?.retryAfter) || 0;
      const wait = secs >= 60 ? `about ${Math.ceil(secs / 60)} minute${secs >= 120 ? 's' : ''}` : `about ${secs} second${secs === 1 ? '' : 's'}`;
      errEl.textContent = secs ? `Too many attempts. Try again in ${wait}.` : 'Too many attempts. Please wait a moment and try again.';
    }
    else errEl.textContent = 'Incorrect username or password.';
  });

  // Forced change
  $('#forced-new').addEventListener('input', (e) => { $('#forced-strength').textContent = strengthLabel(e.target.value); });
  $('#forced-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = $('#forced-current').value;
    const newPassword = $('#forced-new').value;
    const confirm = $('#forced-confirm').value;
    const errEl = $('#forced-error'); errEl.textContent = '';
    if (newPassword !== confirm) { errEl.textContent = 'New passwords do not match.'; return; }
    const btn = e.submitter; btn.disabled = true; btn.classList.add('loading');
    const res = await api.patch('/api/me/password', { currentPassword, newPassword });
    btn.disabled = false; btn.classList.remove('loading');
    if (res.ok) cb.onLoggedIn();
    else errEl.textContent = friendlyError(res.data, 'Could not change password');
  });
  $('#forced-logout').addEventListener('click', async () => { await api.post('/api/logout'); cb.onLoggedIn(); });

  // Change-password modal
  $('#cpw-new').addEventListener('input', (e) => { $('#cpw-strength').textContent = strengthLabel(e.target.value); });
  $('#menu-change-pw').addEventListener('click', () => { $('#account-menu').classList.add('hidden'); openChangePw(); });
  $('#change-pw-close').addEventListener('click', () => closeDialog($('#change-pw')));
  $('#cpw-cancel').addEventListener('click', () => closeDialog($('#change-pw')));
  $('#change-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#cpw-error'); errEl.textContent = '';
    const currentPassword = $('#cpw-current').value;
    const newPassword = $('#cpw-new').value;
    if (newPassword !== $('#cpw-confirm').value) { errEl.textContent = 'New passwords do not match.'; return; }
    const res = await api.patch('/api/me/password', { currentPassword, newPassword });
    if (res.handled) return;
    if (res.ok) { closeDialog($('#change-pw')); toast('ok', 'Password changed'); }
    else errEl.textContent = friendlyError(res.data, 'Could not change password');
  });

  enhancePasswordReveal();
}

function openChangePw() {
  $('#cpw-current').value = ''; $('#cpw-new').value = ''; $('#cpw-confirm').value = '';
  $('#cpw-error').textContent = ''; $('#cpw-strength').textContent = '';
  openDialog($('#change-pw'), { initialFocus: '#cpw-current' });
}

// Add a Show/Hide toggle to every static password field. Especially helpful on
// touch devices and with the long random passwords the panel generates.
export function enhancePasswordReveal() {
  for (const input of document.querySelectorAll('input[type="password"]')) {
    if (input.dataset.reveal === '1') continue;
    input.dataset.reveal = '1';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-reveal';
    btn.textContent = 'Show';
    btn.setAttribute('aria-label', 'Show password');
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    input.insertAdjacentElement('afterend', btn);
    input.parentElement?.classList.add('has-reveal');
  }
}

export function showLoginNotice(msg) {
  const n = $('#login-notice');
  if (msg) { n.textContent = msg; n.hidden = false; } else { n.hidden = true; }
}
