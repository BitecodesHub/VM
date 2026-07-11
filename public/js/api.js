// Fetch wrapper with a central 401 handler. On 401 (except login/setup) it
// invokes the registered onUnauthorized callback and returns a handled sentinel
// so callers bail without double-toasting.

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

const FRIENDLY = {
  FORBIDDEN: 'You do not have permission to do that.',
  QUOTA_EXCEEDED: 'Machine limit reached.',
  RATE_LIMITED: 'Too many attempts — wait a moment.',
  LAST_ADMIN: 'You cannot remove the last administrator.',
  COLIMA_TRANSITION: 'The VM is busy — try again shortly.',
  DOCKER_UNAVAILABLE: 'The VM is not running — start it first.',
  JOB_IN_FLIGHT: 'That machine is already busy.',
  PORT_ALLOC_FAILED: 'No free port available for a new machine.',
  PROTECTED: 'That machine is protected.',
  USER_EXISTS: 'That username is already taken.',
  PASSWORD_CHANGE_REQUIRED: 'Please change your password first.',
};
export function friendlyError(data, fallback) {
  const code = data?.error?.code;
  return FRIENDLY[code] || data?.error?.message || fallback;
}

async function request(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' }, cache: 'no-store' };
  if (body !== undefined) opts.body = JSON.stringify(body);
  let res;
  try { res = await fetch(path, opts); }
  catch { return { status: 0, ok: false, offline: true, data: null }; }

  if (res.status === 401 && !/\/api\/(login|setup)$/.test(path)) {
    onUnauthorized();
    return { status: 401, ok: false, handled: true, data: null };
  }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) { try { data = await res.json(); } catch { /* ignore */ } }
  else data = { text: await res.text() };
  return { status: res.status, ok: res.ok, data };
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  patch: (p, b) => request('PATCH', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p, b) => request('DELETE', p, b),
};
