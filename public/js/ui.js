// Shared UI helpers: DOM, icons, toasts, dialogs (with focus trap), clipboard.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const ICONS = {
  desktop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  browser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>',
  container: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8V16a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
};

// ---- Toasts ----------------------------------------------------------------
export function toast(kind, title, detail) {
  const node = el(`<div class="toast ${kind}"><div class="t-title">${esc(title)}</div>${detail ? `<div class="t-detail">${esc(detail)}</div>` : ''}</div>`);
  $('#toasts').appendChild(node);
  if (kind === 'err') $('#toasts-assertive').textContent = title;
  setTimeout(() => node.remove(), kind === 'err' ? 8000 : 3500);
}

// ---- View switching --------------------------------------------------------
export function showView(name) {
  $$('[data-view]').forEach((s) => s.classList.toggle('hidden', s.dataset.view !== name));
}

// ---- Clipboard -------------------------------------------------------------
export async function copyText(text, note = 'Copied to clipboard') {
  try { await navigator.clipboard.writeText(text); toast('ok', note); }
  catch { toast('err', 'Copy failed — select and copy manually'); }
}

// ---- Dialog focus trap -----------------------------------------------------
const dialogStack = [];
export function openDialog(overlayEl, { initialFocus } = {}) {
  const prevFocus = document.activeElement;
  overlayEl.classList.remove('hidden');
  const panel = overlayEl.querySelector('.overlay-panel, .modal') || overlayEl;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  const entry = { overlayEl, prevFocus };
  dialogStack.push(entry);
  const focusEl = (initialFocus && overlayEl.querySelector(initialFocus)) || panel.querySelector('button, input, select, a[href]');
  setTimeout(() => focusEl?.focus?.(), 20);
  return entry;
}
export function closeDialog(overlayEl) {
  overlayEl.classList.add('hidden');
  const idx = dialogStack.findIndex((e) => e.overlayEl === overlayEl);
  if (idx !== -1) {
    const [entry] = dialogStack.splice(idx, 1);
    entry.prevFocus?.focus?.();
  }
}
export function topDialog() { return dialogStack[dialogStack.length - 1]?.overlayEl || null; }

// Tear down EVERY open dialog — used on session expiry (401) so no modal is left
// stacked on top of the login screen. Clears the focus-trap stack, removes the
// dynamically-created overlays (create wizard, files, sharing, create-user), and
// hides the permanent ones. The permanent overlays are STATIC markup in
// index.html — they must be HIDDEN, never removed, or later code that reaches
// into them (e.g. app.js resetting #viewer-frame on 401) hits a null node and
// the whole boot/logout path throws.
const PERMANENT_OVERLAYS = new Set(['viewer', 'logs', 'confirm', 'change-pw', 'credential']);
export function closeAllDialogs() {
  dialogStack.length = 0;
  document.querySelectorAll('.overlay[data-overlay]').forEach((n) => {
    if (PERMANENT_OVERLAYS.has(n.id)) n.classList.add('hidden');
    else n.remove();
  });
}

// Global Tab trap for the topmost dialog.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const top = topDialog();
  if (!top) return;
  const focusables = [...top.querySelectorAll('button, input, select, a[href], textarea')].filter((n) => !n.disabled && n.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0]; const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ---- Confirm modal ---------------------------------------------------------
let confirmResolve = null;
export function confirmModal({ title, msg, typed = null, okLabel = 'Delete', checkboxLabel = null }) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('#confirm-title').textContent = title;
    $('#confirm-msg').textContent = msg;
    const input = $('#confirm-input');
    const okBtn = $('#confirm-ok');
    const checkRow = $('#confirm-check-row');
    const check = $('#confirm-check');
    okBtn.textContent = okLabel;

    if (checkboxLabel) { $('#confirm-check-label').textContent = checkboxLabel; check.checked = false; checkRow.classList.remove('hidden'); }
    else checkRow.classList.add('hidden');

    if (typed) {
      input.value = ''; input.placeholder = typed; input.classList.remove('hidden');
      okBtn.disabled = true;
      input.oninput = () => { okBtn.disabled = input.value !== typed; };
    } else {
      input.classList.add('hidden'); okBtn.disabled = false; input.oninput = null;
    }
    openDialog($('#confirm'), { initialFocus: typed ? '#confirm-input' : '#confirm-cancel' });
  });
}
export function resolveConfirm(result) {
  if (!confirmResolve) return;
  const payload = result ? { ok: true, checked: $('#confirm-check').checked } : { ok: false };
  closeDialog($('#confirm'));
  const r = confirmResolve; confirmResolve = null;
  r(payload);
}
$('#confirm-cancel')?.addEventListener('click', () => resolveConfirm(false));
$('#confirm-ok')?.addEventListener('click', () => resolveConfirm(true));

// ---- Favicon / title -------------------------------------------------------
const FAVICONS = {
  normal: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%234f8cff'/%3E%3Crect x='7' y='9' width='18' height='12' rx='2' fill='%23fff'/%3E%3Crect x='13' y='22' width='6' height='2' rx='1' fill='%23fff'/%3E%3C/svg%3E",
  grey: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%236b7280'/%3E%3Crect x='7' y='9' width='18' height='12' rx='2' fill='%23fff'/%3E%3C/svg%3E",
  red: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23e5544b'/%3E%3Crect x='7' y='9' width='18' height='12' rx='2' fill='%23fff'/%3E%3C/svg%3E",
};
export function setFavicon(kind) { const l = $('#favicon'); if (l) l.href = FAVICONS[kind] || FAVICONS.normal; }
export function setTitle(t) { document.title = t; }
