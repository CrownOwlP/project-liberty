const { event, core } = window.__TAURI__;
const body = document.querySelector('#props tbody');
const err = document.getElementById('err');
// PL-0748. The first real run showed a window, an overlay and no reason.
const diagnosis = document.getElementById('diagnosis');
const events = document.getElementById('events');
const logpath = document.getElementById('logpath');
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

  // THE ANSWER, IF mpv GAVE ONE. Loud, because the point of this round is
  // that the last run could not say why nothing played.
  if (payload.diagnosis) {
    diagnosis.textContent = payload.diagnosis;
    diagnosis.hidden = false;
  }

  // The tail of the event queue. The full record is in the log file; this is
  // so a person watching the window can see it without opening anything.
  events.textContent = (payload.events || []).slice(-8).join('\n');
  if (payload.log_path && !logpath.textContent) {
    logpath.textContent = 'full log: ' + payload.log_path;
  }
});
// If this click never reaches Rust, the child HWND ate the hit-testing —
// which is one of the pass criteria, so the failure must be visible.
document.getElementById('pause').addEventListener('click', async () => {
  try { await core.invoke('toggle_pause'); }
  catch (e) { err.textContent = 'toggle_pause failed: ' + e; }
});
