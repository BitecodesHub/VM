// Client-side state. The HTTP-only session cookie is the real source of truth;
// this just caches what the UI is currently showing.

export const store = {
  user: null,          // { username, role, mustChangePassword, ... }
  state: null,         // last /api/state payload
  templates: null,     // /api/templates (create tiles)
  busy: new Set(),     // machine names with an action in flight
  ready: new Map(),    // machine name -> true once its UI answered
  pendingCreate: new Set(),
  ownerFilter: '',     // admin All-machines owner filter
  machineSearch: '',   // free-text list filter
  machineSort: 'name', // list sort key: name | state | created
  searchFocused: false, // preserve search-box focus across poll re-renders
};

export function reset() {
  store.user = null;
  store.state = null;
  store.busy.clear();
  store.ready.clear();
  store.pendingCreate.clear();
}
