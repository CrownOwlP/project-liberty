const { event, core } = window.__TAURI__;
const body = document.querySelector('#props tbody');
const err = document.getElementById('err');
event.listen('exp1a://status', ({ payload }) => {
  // Built as nodes, not as an HTML string: a '<' inside a track title would
  // otherwise silently eat the rest of the table, and a reader would be
  // looking at a rendering bug while trying to judge a compositing result.
  const rows = document.createDocumentFragment();
  for (const [k, v] of Object.entries(payload.properties || {})) {
    const tr = document.createElement('tr');
    const key = document.createElement('td');
    const val = document.createElement('td');
    key.textContent = k;
    val.textContent = v;
    tr.append(key, val);
    rows.append(tr);
  }
  body.replaceChildren(rows);
  err.textContent = payload.error || '';
});
// If this click never reaches Rust, the child HWND ate the hit-testing —
// which is one of the pass criteria, so the failure must be visible.
document.getElementById('pause').addEventListener('click', async () => {
  try { await core.invoke('toggle_pause'); }
  catch (e) { err.textContent = 'toggle_pause failed: ' + e; }
});
