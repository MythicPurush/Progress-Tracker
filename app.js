let page = 'home';
let selectedSubject = '';
let timerId = null;
let elapsed = 0;
let timerStartedAt = 0;
let timerBaseElapsed = 0;
let viewDate = new Date();
let statsYear = new Date().getFullYear();
let authToken = localStorage.getItem('pt.authToken') || '';
let authUser = null;
let friendView = null;
let myData = { user: null, subjects: [], sessions: [] };

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const key = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const fmt = s => { s = Math.max(0, Math.floor(s)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const hours = s => (s / 3600).toFixed(1);
const fmtShort = s => { if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s / 60)}m`; return `${(s / 3600).toFixed(1)}h`; };

const inFriendMode = () => !!friendView;
const friendTotalsOnly = () => friendView && friendView.sharingLevel === 'totals';
const currentData = () => inFriendMode() ? friendView : myData;
const subjectsFor = d => (d.subjects || []).map(s => typeof s === 'string' ? s : s.name);
const sessionsFor = d => d.sessions || [];
const activeSubjects = () => subjectsFor(currentData());
const activeSessions = () => sessionsFor(currentData());
const activeTotals = () => friendTotalsOnly() ? friendView.totals : null;

const liveElapsed = () => timerId && timerStartedAt ? timerBaseElapsed + Math.max(0, Math.floor((Date.now() - timerStartedAt) / 1000)) : elapsed;
const total = () => {
  if (friendTotalsOnly()) return activeTotals().totalSeconds;
  return activeSessions().reduce((a, s) => a + s.seconds, 0) + (!inFriendMode() ? liveElapsed() : 0);
};
const level = () => Math.floor(total() / 3600 / 10) + 1;
const monthSessions = (y, m) => activeSessions().filter(s => { const d = new Date(s.started); return d.getFullYear() === y && d.getMonth() === m; });
const dayTotal = k => activeSessions().filter(s => key(s.started) === k).reduce((a, s) => a + s.seconds, 0);

function toast(msg) { alert(msg); }

async function callApi(fn, payload) {
  try {
    return await fn(payload);
  } catch (e) {
    throw new Error(e?.message || 'Request failed');
  }
}

async function loadSelfData() {
  if (!authToken) return;
  const data = await callApi(window.studyAPI.loadSelf, { token: authToken });
  myData = data;
  authUser = data.user;
  if (!selectedSubject) selectedSubject = subjectsFor(myData)[0] || '';
}

async function loadFriendData(friendUserId) {
  friendView = await callApi(window.studyAPI.loadFriend, { token: authToken, friendUserId });
  if (friendView.sharingLevel === 'full') {
    friendView.subjects = friendView.subjects || [];
    friendView.sessions = friendView.sessions || [];
  }
}

function refreshHeader() {
  const mode = inFriendMode()
    ? `FRIEND VIEW · ${friendView.user.display_name} (${friendView.sharingLevel === 'totals' ? 'totals only' : 'full'})`
    : `PERSONAL PROGRESS SYSTEM · ${authUser ? authUser.display_name : ''}`;
  $('#headerMode').textContent = mode;
  $('#level').textContent = level();
}

function authPage() {
  $('#title').textContent = 'Sign in';
  $('#headerMode').textContent = 'MULTI-USER PROGRESS SYSTEM';
  $('#level').textContent = '1';
  $('#content').innerHTML = `<div class="page"><div class="auth-wrap"><div class="card"><h2>Welcome</h2><div class="muted">Create an account or log in to sync your progress, add friends, and view shared analytics.</div><div class="auth-grid mt"><div><h3>Login</h3><input id="loginEmail" class="modal-input" type="email" placeholder="you@example.com"><input id="loginPassword" class="modal-input mt-10" type="password" placeholder="Password (min 8)"><button class="primary mt-10" id="loginBtn">Login</button></div><div><h3>Sign up</h3><input id="signupName" class="modal-input" type="text" placeholder="Display name"><input id="signupEmail" class="modal-input mt-10" type="email" placeholder="you@example.com"><input id="signupPassword" class="modal-input mt-10" type="password" placeholder="Password (min 8)"><button class="primary mt-10" id="signupBtn">Create account</button></div></div></div></div></div>`;
  $('#loginBtn').onclick = async () => {
    try {
      const email = $('#loginEmail').value.trim();
      const password = $('#loginPassword').value;
      const res = await callApi(window.studyAPI.login, { email, password });
      authToken = res.token;
      localStorage.setItem('pt.authToken', authToken);
      myData = res.data;
      authUser = res.data.user;
      friendView = null;
      selectedSubject = subjectsFor(myData)[0] || '';
      render();
    } catch (e) { toast(e.message); }
  };
  $('#signupBtn').onclick = async () => {
    try {
      const displayName = $('#signupName').value.trim();
      const email = $('#signupEmail').value.trim();
      const password = $('#signupPassword').value;
      const res = await callApi(window.studyAPI.signup, { displayName, email, password });
      authToken = res.token;
      localStorage.setItem('pt.authToken', authToken);
      myData = res.data;
      authUser = res.data.user;
      friendView = null;
      selectedSubject = subjectsFor(myData)[0] || '';
      render();
    } catch (e) { toast(e.message); }
  };
}

function render() {
  if (!authToken) {
    authPage();
    return;
  }

  if (timerId && !inFriendMode()) elapsed = liveElapsed();
  refreshHeader();

  const titles = { home: 'Overview', timer: 'Timer', calendar: 'Calendar', analytics: 'Statistics', consistency: 'Consistency', history: 'History', growth: 'Growth', friends: 'Friends', requests: 'Friend Requests', profile: 'Profile' };
  $('#title').textContent = titles[page] || 'Overview';

  const pages = { home, timer: timerPage, calendar: calendarPage, analytics: analyticsPage, consistency: consistencyPage, history: historyPage, growth: growthPage, friends: friendsPage, requests: requestsPage, profile: profilePage };
  (pages[page] || home)();
}

function restrictedFriendPage(message = 'This friend shares totals only for privacy.') {
  $('#content').innerHTML = `<div class="page"><div class="card"><h3>Limited access</h3><div class="muted">${esc(message)}</div></div></div>`;
}

function home() {
  if (friendTotalsOnly()) {
    const t = activeTotals();
    $('#content').innerHTML = `<div class="page"><div class="grid g4"><div class="card metric"><span class="eyebrow2">TODAY</span><strong>${fmt(t.todaySeconds)}</strong><small>shared total</small></div><div class="card metric"><span class="eyebrow2">LAST 7 DAYS</span><strong>${fmt(t.last7DaysSeconds)}</strong><small>shared total</small></div><div class="card metric"><span class="eyebrow2">ALL TIME</span><strong>${hours(t.totalSeconds)}h</strong><small>${t.sessionsCount} sessions</small></div><div class="card metric"><span class="eyebrow2">ACTIVE DAYS</span><strong>${t.activeDays}</strong><small>shared value</small></div></div><div class="card mt"><h3>Subject distribution</h3>${pie(t.subjectTotals)}</div></div>`;
    return;
  }

  const now = new Date();
  const today = dayTotal(key(now));
  const week = activeSessions().filter(s => { const d = new Date(s.started); return (now - d) / 86400000 < 7; }).reduce((a, s) => a + s.seconds, 0);
  const active = new Set(activeSessions().map(s => key(s.started))).size;
  $('#content').innerHTML = `<div class="page"><div class="grid g4"><div class="card metric"><span class="eyebrow2">TODAY</span><strong>${fmt(today)}</strong><small>recorded study time</small></div><div class="card metric"><span class="eyebrow2">LAST 7 DAYS</span><strong>${fmt(week)}</strong><small>rolling week</small></div><div class="card metric"><span class="eyebrow2">ALL TIME</span><strong>${hours(total())}h</strong><small>${activeSessions().length} sessions</small></div><div class="card metric"><span class="eyebrow2">ACTIVE DAYS</span><strong>${active}</strong><small>days with recorded time</small></div></div><div class="grid g2 mt"><div class="card"><div class="cardhead"><h3>Last 14 days</h3><button class="linkbtn" id="goCal">Open calendar</button></div>${dailyBars(14)}</div><div class="card"><h3>Subject distribution</h3>${pie(subjectTotals())}</div></div><div class="grid g2 mt"><div class="card"><h3>Consistency heatmap</h3>${yearHeatmap(new Date().getFullYear(), false)}</div><div class="card"><h3>Study patterns</h3>${patternCards()}</div></div></div>`;
  $('#goCal').onclick = () => { page = 'calendar'; syncNav(); render(); };
}

function patternCards() {
  const longest = Math.max(0, ...activeSessions().map(s => s.seconds));
  const a = Array(24).fill(0);
  activeSessions().forEach(s => a[new Date(s.started).getHours()] += s.seconds);
  const bh = a.indexOf(Math.max(...a));
  return `<div class="pattern-grid"><div><small>Longest session</small><b>${fmt(longest)}</b></div><div><small>Best hour</small><b>${String(bh).padStart(2, '0')}:00</b></div><div><small>Avg session</small><b>${activeSessions().length ? fmt(total() / activeSessions().length) : '00:00:00'}</b></div><div><small>Current streak</small><b>${streak()}d</b></div></div>`;
}

function timerPage() {
  if (inFriendMode()) return restrictedFriendPage('Timer is only available on your own profile.');
  const mySubjects = subjectsFor(myData);
  if (!selectedSubject && mySubjects.length) selectedSubject = mySubjects[0];
  if (timerId) elapsed = liveElapsed();
  $('#content').innerHTML = `<div class="page"><div class="grid g2"><div class="card timerbox"><span class="eyebrow2">LIVE STUDY TIMER</span><div class="clock" id="clock">${fmt(elapsed)}</div><div class="timer-sub">${selectedSubject ? esc(selectedSubject) : 'No subject selected'}</div><div class="controls"><button class="primary" id="startBtn">${timerId ? 'Pause' : 'Start'}</button><button id="finishBtn">Finish session</button></div><div class="muted">Only completed sessions are saved to your account.</div></div><div class="card"><div class="cardhead"><h3>Subjects</h3><button class="primary small" id="addSubject">+ Add</button></div><div id="subjectsList" class="subjects-list">${subjectEditor()}</div></div></div><div class="card mt"><div class="cardhead"><h3>Recent sessions</h3><button class="linkbtn" id="historyBtn">Full history</button></div>${recentRows(8)}</div></div>`;
  bindTimer();
}

function subjectEditor() {
  const subjects = myData.subjects || [];
  return subjects.length ? subjects.map((s, i) => `<div class="subject-item ${s.name === selectedSubject ? 'selected' : ''}"><button class="subject-main" data-select-index="${i}"><span class="dot d${i % 6}"></span><span>${esc(s.name)}</span></button><div class="subject-actions"><button class="iconbtn" data-rename-index="${i}" title="Rename subject">✎</button><button class="iconbtn danger" data-delete-index="${i}" title="Delete subject">×</button></div></div>`).join('') : '<div class="empty">No subjects. Add one to begin.</div>';
}

function subjectDialog(title, initial = '', actionLabel = 'Save') { return new Promise(resolve => { const old = document.getElementById('subjectModal'); if (old) old.remove(); const modal = document.createElement('div'); modal.id = 'subjectModal'; modal.className = 'modal-backdrop'; modal.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true"><div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" id="modalCancel" type="button">×</button></div><input id="subjectInput" class="modal-input" type="text" maxlength="80" value="${esc(initial)}"><div id="subjectError" class="modal-error"></div><div class="modal-actions"><button id="modalCancel2" type="button">Cancel</button><button id="modalSave" class="primary" type="button">${esc(actionLabel)}</button></div></div>`; document.body.appendChild(modal); const input = modal.querySelector('#subjectInput'); const error = modal.querySelector('#subjectError'); let done = false; const close = value => { if (done) return; done = true; modal.remove(); resolve(value); }; const submit = () => { const value = input.value.trim(); if (!value) { error.textContent = 'Enter a subject name.'; input.focus(); return; } close(value); }; modal.querySelector('#modalSave').onclick = submit; modal.querySelector('#modalCancel').onclick = () => close(null); modal.querySelector('#modalCancel2').onclick = () => close(null); modal.addEventListener('mousedown', e => { if (e.target === modal) close(null); }); input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') close(null); }); requestAnimationFrame(() => { input.focus(); input.select(); }); }); }
function confirmDialog(title, message, confirmLabel = 'Delete') { return new Promise(resolve => { const old = document.getElementById('confirmModal'); if (old) old.remove(); const modal = document.createElement('div'); modal.id = 'confirmModal'; modal.className = 'modal-backdrop'; modal.innerHTML = `<div class="modal-card"><div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" id="confirmX" type="button">×</button></div><div class="muted confirm-message">${esc(message)}</div><div class="modal-actions"><button id="confirmNo" type="button">Cancel</button><button id="confirmYes" class="primary danger-action" type="button">${esc(confirmLabel)}</button></div></div>`; document.body.appendChild(modal); let done = false; const close = value => { if (done) return; done = true; modal.remove(); resolve(value); }; modal.querySelector('#confirmYes').onclick = () => close(true); modal.querySelector('#confirmNo').onclick = () => close(false); modal.querySelector('#confirmX').onclick = () => close(false); modal.addEventListener('mousedown', e => { if (e.target === modal) close(false); }); requestAnimationFrame(() => modal.querySelector('#confirmYes').focus()); }); }

function refreshTimerNow() { if (!timerId || !timerStartedAt) return; elapsed = liveElapsed(); const c = $('#clock'); if (c) c.textContent = fmt(elapsed); $('#level').textContent = level(); }
function startTimer() { if (timerId || inFriendMode()) return; timerBaseElapsed = elapsed; timerStartedAt = Date.now(); timerId = setInterval(refreshTimerNow, 250); refreshTimerNow(); }
function pauseTimer() { if (!timerId) return; refreshTimerNow(); clearInterval(timerId); timerId = null; timerStartedAt = 0; timerBaseElapsed = elapsed; render(); }
window.addEventListener('focus', refreshTimerNow); window.addEventListener('pageshow', refreshTimerNow); document.addEventListener('visibilitychange', refreshTimerNow);

function bindTimer() {
  document.querySelectorAll('[data-select-index]').forEach(b => b.onclick = () => { const i = Number(b.dataset.selectIndex); if (Number.isInteger(i) && myData.subjects[i]) { selectedSubject = myData.subjects[i].name; render(); } });
  $('#startBtn').onclick = () => { if (timerId) pauseTimer(); else { startTimer(); render(); } };
  $('#finishBtn').onclick = finishSession;
  $('#historyBtn').onclick = () => { page = 'history'; syncNav(); render(); };
  $('#addSubject').onclick = addSubject;
  document.querySelectorAll('[data-rename-index]').forEach(b => b.onclick = () => renameSubject(Number(b.dataset.renameIndex)));
  document.querySelectorAll('[data-delete-index]').forEach(b => b.onclick = () => deleteSubject(Number(b.dataset.deleteIndex)));
}

async function addSubject() { const name = await subjectDialog('Add subject', '', 'Add subject'); if (name === null) return; try { myData = await callApi(window.studyAPI.addSubject, { token: authToken, name }); if (!selectedSubject) selectedSubject = name; render(); } catch (e) { toast(e.message); } }
async function renameSubject(index) { if (!Number.isInteger(index) || !myData.subjects[index]) return; const old = myData.subjects[index]; const name = await subjectDialog('Edit subject', old.name, 'Save changes'); if (name === null || name === old.name) return; try { myData = await callApi(window.studyAPI.renameSubject, { token: authToken, subjectId: old.id, name }); if (selectedSubject === old.name) selectedSubject = name; render(); } catch (e) { toast(e.message); } }
async function deleteSubject(index) { if (!Number.isInteger(index) || !myData.subjects[index]) return; const subject = myData.subjects[index]; const ok = await confirmDialog('Delete subject?', `Delete “${subject.name}” from your subject list? Existing session history will be preserved.`); if (!ok) return; try { myData = await callApi(window.studyAPI.deleteSubject, { token: authToken, subjectId: subject.id }); if (selectedSubject === subject.name) selectedSubject = subjectsFor(myData)[0] || ''; render(); } catch (e) { toast(e.message); } }

async function finishSession() {
  if (timerId) { elapsed = liveElapsed(); clearInterval(timerId); timerId = null; }
  if (elapsed < 2) { elapsed = 0; timerStartedAt = 0; timerBaseElapsed = 0; render(); return; }
  try {
    myData = await callApi(window.studyAPI.addSession, {
      token: authToken,
      started: new Date(Date.now() - elapsed * 1000).toISOString(),
      seconds: elapsed,
      subject: selectedSubject || 'Uncategorized'
    });
  } catch (e) {
    toast(e.message);
  }
  elapsed = 0;
  timerStartedAt = 0;
  timerBaseElapsed = 0;
  render();
}

function calendarPage() {
  if (friendTotalsOnly()) return restrictedFriendPage();
  const y = viewDate.getFullYear(), m = viewDate.getMonth(), first = new Date(y, m, 1), last = new Date(y, m + 1, 0), cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push('<div class="day emptyday"></div>');
  for (let d = 1; d <= last.getDate(); d++) { const k = key(new Date(y, m, d)), v = dayTotal(k); cells.push(`<button class="day ${v ? 'hasdata' : ''}" data-day="${k}"><span>${d}</span><b>${v ? fmtShort(v) : '—'}</b></button>`); }
  $('#content').innerHTML = `<div class="page"><div class="calendar-card card"><div class="monthnav"><button id="calPrev">←</button><div><span class="eyebrow2">MONTH</span><h2>${viewDate.toLocaleString('en', { month: 'long', year: 'numeric' })}</h2></div><button id="calNext">→</button></div><div class="calendar-total">Total study <b>${hours(monthSessions(y, m).reduce((a, s) => a + s.seconds, 0))}h</b></div><div class="weekdays">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(x => `<span>${x}</span>`).join('')}</div><div class="calendar-grid">${cells.join('')}</div></div><div class="card mt"><div class="cardhead"><h3>${y} Year Heatmap</h3><div class="year-controls"><button id="yearPrev">←</button><b>${y}</b><button id="yearNext">→</button></div></div>${yearHeatmap(y, true)}</div></div>`;
  $('#calPrev').onclick = () => { viewDate = new Date(y, m - 1, 1); render(); };
  $('#calNext').onclick = () => { viewDate = new Date(y, m + 1, 1); render(); };
  $('#yearPrev').onclick = () => { viewDate = new Date(y - 1, m, 1); render(); };
  $('#yearNext').onclick = () => { viewDate = new Date(y + 1, m, 1); render(); };
  document.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { const [yy, mm, dd] = b.dataset.day.split('-').map(Number); showDay(yy, mm - 1, dd); });
}

function showDay(y, m, d) { const k = key(new Date(y, m, d)); const rows = activeSessions().filter(s => key(s.started) === k).sort((a, b) => new Date(a.started) - new Date(b.started)); alert(`${new Date(y, m, d).toLocaleDateString()}\n\nStudy time: ${fmt(rows.reduce((a, s) => a + s.seconds, 0))}\nSessions: ${rows.length}\n${rows.map(s => `${s.subject} — ${fmt(s.seconds)}`).join('\n') || 'No sessions'}`); }

function analyticsPage() {
  if (friendTotalsOnly()) {
    const t = activeTotals();
    $('#content').innerHTML = `<div class="page"><div class="grid g4"><div class="card metric"><span class="eyebrow2">YEAR TOTAL (ALL SHARED)</span><strong>${hours(t.totalSeconds)}h</strong><small>${t.sessionsCount} sessions</small></div><div class="card metric"><span class="eyebrow2">ACTIVE DAYS</span><strong>${t.activeDays}</strong><small>shared aggregate</small></div><div class="card metric"><span class="eyebrow2">TODAY</span><strong>${fmt(t.todaySeconds)}</strong><small>shared aggregate</small></div><div class="card metric"><span class="eyebrow2">LAST 7 DAYS</span><strong>${fmt(t.last7DaysSeconds)}</strong><small>shared aggregate</small></div></div><div class="card mt"><h3>Subject breakdown</h3>${pie(t.subjectTotals)}</div></div>`;
    return;
  }
  const y = statsYear, ss = activeSessions().filter(s => new Date(s.started).getFullYear() === y), totalY = ss.reduce((a, s) => a + s.seconds, 0);
  $('#content').innerHTML = `<div class="page"><div class="yearbar"><button id="syPrev">←</button><div><span class="eyebrow2">YEAR</span><h2>${y}</h2></div><button id="syNext">→</button></div><div class="grid g4"><div class="card metric"><span class="eyebrow2">YEAR TOTAL</span><strong>${hours(totalY)}h</strong><small>${ss.length} sessions</small></div><div class="card metric"><span class="eyebrow2">ACTIVE DAYS</span><strong>${new Set(ss.map(s => key(s.started))).size}</strong><small>in ${y}</small></div><div class="card metric"><span class="eyebrow2">DAILY AVG</span><strong>${hours(totalY / 365)}h</strong><small>calendar-day average</small></div><div class="card metric"><span class="eyebrow2">LONGEST</span><strong>${fmt(Math.max(0, ...ss.map(s => s.seconds)))}</strong><small>single session</small></div></div><div class="grid g2 mt"><div class="card"><h3>Monthly trend</h3>${monthlyTrend(y)}</div><div class="card"><h3>Subject breakdown</h3>${pie(subjectTotals(y))}</div></div><div class="grid g2 mt"><div class="card"><h3>24-hour study pattern</h3>${hourBars(ss)}</div><div class="card"><h3>Weekday pattern</h3>${weekdayBars(ss)}</div></div><div class="card mt"><h3>Monthly archive</h3>${monthlyTable(y)}</div></div>`;
  $('#syPrev').onclick = () => { statsYear = y - 1; render(); };
  $('#syNext').onclick = () => { statsYear = y + 1; render(); };
}

function consistencyPage() {
  if (friendTotalsOnly()) return restrictedFriendPage();
  const ss = activeSessions();
  const byHour = Array(24).fill(0), byDay = Array(7).fill(0);
  ss.forEach(s => { const d = new Date(s.started); byHour[d.getHours()] += s.seconds; byDay[d.getDay()] += s.seconds; });
  const peak = byHour.indexOf(Math.max(...byHour));
  $('#content').innerHTML = `<div class="page"><div class="grid g2"><div class="card"><h3>When you study best</h3><div class="peak">${String(peak).padStart(2, '0')}:00</div><div class="muted">Highest recorded study-time window</div>${hourBars(ss)}</div><div class="card"><h3>Weekday effectiveness</h3>${weekdayBars(ss)}</div></div><div class="card mt"><h3>Consistency heatmap</h3>${yearHeatmap(new Date().getFullYear(), true)}</div><div class="grid g3 mt"><div class="card metric"><span class="eyebrow2">ACTIVE DAYS</span><strong>${new Set(ss.map(s => key(s.started))).size}</strong></div><div class="card metric"><span class="eyebrow2">SESSIONS</span><strong>${ss.length}</strong></div><div class="card metric"><span class="eyebrow2">AVG SESSION</span><strong>${ss.length ? fmt(total() / ss.length) : '00:00:00'}</strong></div></div></div>`;
}

function historyPage() {
  if (friendTotalsOnly()) return restrictedFriendPage();
  const rows = [...activeSessions()].sort((a, b) => new Date(b.started) - new Date(a.started));
  const canDelete = !inFriendMode();
  $('#content').innerHTML = `<div class="page"><div class="card"><div class="cardhead"><div><h3>Session history</h3><div class="muted">Raw record behind your graphs.</div></div><div class="history-count">${rows.length} sessions</div></div>${rows.length ? `<div class="tablewrap"><table class="table"><thead><tr><th>Date & time</th><th>Subject</th><th>Duration</th><th></th></tr></thead><tbody>${rows.map(s => `<tr><td>${new Date(s.started).toLocaleString()}</td><td>${esc(s.subject)}</td><td>${fmt(s.seconds)}</td><td>${canDelete ? `<button class="iconbtn danger" data-remove="${s.id}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No sessions yet.</div>'}</div></div>`;
  if (canDelete) document.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this session?')) return;
    try { myData = await callApi(window.studyAPI.deleteSession, { token: authToken, sessionId: b.dataset.remove }); render(); } catch (e) { toast(e.message); }
  });
}

function growthPage() {
  const h = total() / 3600, st = [0, 5, 20, 50, 100, 200, 350, 550, 800, 1100, 1500, 2000, 2700, 3600, 4800, 6200, 8000, 10000], names = ['Seed', 'Sprout', 'Seedling', 'Young Tree', 'Mature', 'Blooming', 'Tree', 'Ancient', 'Legendary', 'Mythic', 'Eternal', 'Ascendant', 'Titan', 'Colossus', 'World Tree', 'Evergreen', 'Mastery', 'Complete'];
  let i = st.findIndex((v, j) => h >= v && h < (st[j + 1] ?? Infinity)); if (i < 0) i = st.length - 1;
  const next = st[i + 1] ?? 10000, base = st[i], pct = i === st.length - 1 ? 100 : (h - base) / (next - base) * 100;
  $('#content').innerHTML = `<div class="page"><div class="card tree-card"><span class="eyebrow2">GROWTH</span><h2>${names[i]}</h2><div class="tree">${treeSvg(Math.min(1, h / 10000))}</div><strong class="tree-hours">${h.toFixed(1)} hours</strong><div class="muted">${i === st.length - 1 ? 'Final growth stage reached.' : 'Next: ' + names[i + 1] + ' at ' + next.toLocaleString() + 'h'}</div></div><div class="card mt"><div class="cardhead"><b>Progress to next stage</b><b>${pct.toFixed(0)}%</b></div><div class="growthbar"><div style="width:${pct}%"></div></div></div><div class="card mt"><h3>Growth journey</h3><div class="growth-grid">${st.map((v, j) => `<div class="growth-stage ${j <= i ? 'done' : ''}"><b>${names[j]}</b><small>${v.toLocaleString()}h</small></div>`).join('')}</div></div></div>`;
}

async function friendsPage() {
  const rows = await callApi(window.studyAPI.listFriends, { token: authToken });
  $('#content').innerHTML = `<div class="page"><div class="card"><div class="cardhead"><h3>Friends</h3><button class="primary small" id="refreshFriends">Refresh</button></div><div class="muted">View accepted friends' shared progress and manage relationships.</div>${rows.length ? `<div class="tablewrap mt"><table class="table"><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Sharing</th><th>Actions</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.display_name)}</td><td>${esc(r.email)}</td><td>${esc(r.status)}</td><td>${esc(r.sharing_level)}</td><td>${r.status === 'accepted' ? `<button class="iconbtn" data-view="${r.id}">View</button>` : ''} <button class="iconbtn danger" data-block="${r.friendship_id}">Block</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty mt">No friends yet.</div>'}</div></div>`;
  $('#refreshFriends').onclick = () => render();
  document.querySelectorAll('[data-view]').forEach(b => b.onclick = async () => {
    try {
      await loadFriendData(b.dataset.view);
      page = 'home';
      syncNav();
      render();
    } catch (e) { toast(e.message); }
  });
  document.querySelectorAll('[data-block]').forEach(b => b.onclick = async () => {
    if (!confirm('Block this user?')) return;
    try {
      await callApi(window.studyAPI.blockFriend, { token: authToken, friendshipId: b.dataset.block });
      if (friendView && friendView.user && rows.some(r => r.id === friendView.user.id && r.friendship_id === b.dataset.block)) friendView = null;
      render();
    } catch (e) { toast(e.message); }
  });
}

async function requestsPage() {
  const req = await callApi(window.studyAPI.listFriendRequests, { token: authToken });
  $('#content').innerHTML = `<div class="page"><div class="grid g2"><div class="card"><h3>Send friend request</h3><input id="friendEmail" class="modal-input" type="email" placeholder="friend@example.com"><button class="primary mt-10" id="sendReq">Send request</button></div><div class="card"><h3>Search users</h3><input id="searchInput" class="modal-input" type="text" placeholder="email fragment"><div id="searchRes" class="mt-10"></div></div></div><div class="grid g2 mt"><div class="card"><h3>Incoming</h3>${req.incoming.length ? req.incoming.map(r => `<div class="request-row"><div><b>${esc(r.display_name)}</b><small>${esc(r.email)}</small></div><div><button class="iconbtn" data-accept="${r.id}">Accept</button> <button class="iconbtn danger" data-reject="${r.id}">Reject</button></div></div>`).join('') : '<div class="empty">No incoming requests.</div>'}</div><div class="card"><h3>Outgoing</h3>${req.outgoing.length ? req.outgoing.map(r => `<div class="request-row"><div><b>${esc(r.display_name)}</b><small>${esc(r.email)}</small></div><div class="muted">Pending</div></div>`).join('') : '<div class="empty">No pending outgoing requests.</div>'}</div></div></div>`;
  $('#sendReq').onclick = async () => {
    const email = $('#friendEmail').value.trim();
    try { await callApi(window.studyAPI.sendFriendRequest, { token: authToken, email }); toast('Friend request sent.'); render(); } catch (e) { toast(e.message); }
  };
  $('#searchInput').addEventListener('input', async () => {
    const q = $('#searchInput').value.trim();
    if (q.length < 3) { $('#searchRes').innerHTML = ''; return; }
    try {
      const res = await callApi(window.studyAPI.searchUsers, { token: authToken, query: q });
      $('#searchRes').innerHTML = res.length ? `<div class="search-list">${res.map(u => `<div><b>${esc(u.display_name)}</b><small>${esc(u.email)}</small><button class="iconbtn" data-email="${esc(u.email)}">Request</button></div>`).join('')}</div>` : '<div class="muted">No matches.</div>';
      document.querySelectorAll('[data-email]').forEach(btn => btn.onclick = async () => {
        try { await callApi(window.studyAPI.sendFriendRequest, { token: authToken, email: btn.dataset.email }); toast('Friend request sent.'); render(); } catch (e) { toast(e.message); }
      });
    } catch (e) {
      $('#searchRes').innerHTML = `<div class="muted">${esc(e.message)}</div>`;
    }
  });
  document.querySelectorAll('[data-accept]').forEach(b => b.onclick = async () => { try { await callApi(window.studyAPI.respondFriendRequest, { token: authToken, friendshipId: b.dataset.accept, action: 'accept' }); render(); } catch (e) { toast(e.message); } });
  document.querySelectorAll('[data-reject]').forEach(b => b.onclick = async () => { try { await callApi(window.studyAPI.respondFriendRequest, { token: authToken, friendshipId: b.dataset.reject, action: 'reject' }); render(); } catch (e) { toast(e.message); } });
}

function profilePage() {
  $('#content').innerHTML = `<div class="page"><div class="card"><h3>Profile</h3><div class="grid g2"><div><small class="muted">Email</small><div class="profile-value">${esc(authUser.email)}</div></div><div><small class="muted">Display name</small><input id="displayName" class="modal-input" value="${esc(authUser.display_name)}"></div></div><div class="grid g2 mt"><div><small class="muted">Privacy</small><select id="sharingLevel" class="modal-input"><option value="full" ${authUser.sharing_level === 'full' ? 'selected' : ''}>Friends can view full progress</option><option value="totals" ${authUser.sharing_level === 'totals' ? 'selected' : ''}>Friends can view totals only</option></select></div><div class="profile-actions"><button class="primary" id="saveProfile">Save profile</button><button id="exitFriendView" ${inFriendMode() ? '' : 'disabled'}>Exit friend view</button><button id="logout">Log out</button></div></div></div><div class="card mt"><h3>Data management</h3><div class="muted">Backup/restore stays per account even in cloud mode.</div></div></div>`;
  $('#saveProfile').onclick = async () => {
    try {
      authUser = await callApi(window.studyAPI.updateProfile, {
        token: authToken,
        displayName: $('#displayName').value.trim(),
        sharingLevel: $('#sharingLevel').value
      });
      myData.user = authUser;
      toast('Profile updated.');
      render();
    } catch (e) { toast(e.message); }
  };
  $('#exitFriendView').onclick = () => { friendView = null; page = 'home'; syncNav(); render(); };
  $('#logout').onclick = async () => {
    try { await callApi(window.studyAPI.logout, { token: authToken }); } catch { }
    authToken = '';
    authUser = null;
    myData = { user: null, subjects: [], sessions: [] };
    friendView = null;
    localStorage.removeItem('pt.authToken');
    render();
  };
}

function subjectTotals(year = null) {
  const subjects = activeSubjects();
  const sessions = activeSessions();
  return subjects.map(x => [x, sessions.filter(s => (year === null || new Date(s.started).getFullYear() === year) && s.subject === x).reduce((a, s) => a + s.seconds, 0)])
    .filter(x => x[1] > 0)
    .concat([['Other', sessions.filter(s => !subjects.includes(s.subject) && (year === null || new Date(s.started).getFullYear() === year)).reduce((a, s) => a + s.seconds, 0)]])
    .filter(x => x[1] > 0);
}
function dailyBars(n) { const vals = []; for (let i = n - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); vals.push([d.getDate(), dayTotal(key(d))]); } const mx = Math.max(1, ...vals.map(x => x[1])); return `<div class="chart">${vals.map(x => `<div class="barwrap"><div class="bar" style="height:${Math.max(3, x[1] / mx * 170)}px"></div><span>${x[0]}</span></div>`).join('')}</div>`; }
function monthlyTrend(y) { const vals = Array.from({ length: 12 }, (_, m) => monthSessions(y, m).reduce((a, s) => a + s.seconds, 0)); const mx = Math.max(1, ...vals); return `<div class="chart tall">${vals.map((v, i) => `<div class="barwrap"><div class="bar" style="height:${Math.max(3, v / mx * 190)}px"></div><span>${['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'][i]}</span></div>`).join('')}</div>`; }
function hourBars(ss) { const vals = Array(24).fill(0); ss.forEach(s => vals[new Date(s.started).getHours()] += s.seconds); return barChart(vals, 24, i => String(i).padStart(2, '0')); }
function weekdayBars(ss) { const vals = Array(7).fill(0); ss.forEach(s => vals[new Date(s.started).getDay()] += s.seconds); return barChart(vals, 7, i => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i]); }
function barChart(vals, count, label) { const mx = Math.max(1, ...vals); return `<div class="chart tall">${vals.slice(0, count).map((v, i) => `<div class="barwrap"><div class="bar" style="height:${Math.max(3, v / mx * 180)}px"></div><span>${label(i)}</span></div>`).join('')}</div>`; }
function pie(items) { const totalV = items.reduce((a, x) => a + x[1], 0); if (!totalV) return '<div class="empty">No recorded data yet.</div>'; let angle = -Math.PI / 2, r = 78, c = 100, colors = ['#4fa3ff', '#58d6a0', '#a88cff', '#ffad6b', '#ff6f91', '#67d9ef'], paths = ''; items.forEach((x, i) => { const a = x[1] / totalV * Math.PI * 2, x1 = c + r * Math.cos(angle), y1 = c + r * Math.sin(angle), x2 = c + r * Math.cos(angle + a), y2 = c + r * Math.sin(angle + a); paths += `<path d="M ${c} ${c} L ${x1} ${y1} A ${r} ${r} 0 ${a > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z" fill="${colors[i % colors.length]}"/>`; angle += a; }); return `<div class="piebox"><svg viewBox="0 0 200 200"><circle cx="100" cy="100" r="82" fill="#09131e"/>${paths}<circle cx="100" cy="100" r="47" fill="#09131e"/></svg><div class="legend">${items.map((x, i) => `<div><i style="background:${colors[i % colors.length]}"></i><span>${esc(x[0])}</span><b>${hours(x[1])}h</b></div>`).join('')}</div></div>`; }
function heatmapCells(y) { const start = new Date(y, 0, 1); let cells = ''; for (let i = 0; i < start.getDay(); i++) cells += '<div></div>'; for (let d = 1; d <= 365 + (new Date(y, 1, 29).getMonth() === 1 ? 1 : 0); d++) { const date = new Date(y, 0, d); const v = dayTotal(key(date)); const level = v === 0 ? 0 : v < 1800 ? 1 : v < 3600 ? 2 : v < 7200 ? 3 : 4; cells += `<div class="hcell h${level}" title="${key(date)} · ${fmtShort(v)}"></div>`; } return cells; }
function yearHeatmap(y, full) { return `<div class="heatwrap ${full ? 'full' : ''}"><div class="heatgrid">${heatmapCells(y)}</div><div class="heatlegend"><span>Less</span><i class="hcell h0"></i><i class="hcell h1"></i><i class="hcell h2"></i><i class="hcell h3"></i><i class="hcell h4"></i><span>More</span></div></div>`; }
function monthlyTable(y) { return `<div class="monthtable">${Array.from({ length: 12 }, (_, m) => { const t = monthSessions(y, m).reduce((a, s) => a + s.seconds, 0), a = new Set(monthSessions(y, m).map(s => key(s.started))).size; return `<div><b>${new Date(y, m, 1).toLocaleString('en', { month: 'long' })}</b><span>${hours(t)}h</span><small>${a} active days</small></div>`; }).join('')}</div>`; }
function recentRows(n) { const rows = [...activeSessions()].sort((a, b) => new Date(b.started) - new Date(a.started)).slice(0, n); return rows.length ? `<div class="session-list">${rows.map(s => `<div class="session-row"><div><b>${esc(s.subject)}</b><small>${new Date(s.started).toLocaleString()}</small></div><strong>${fmt(s.seconds)}</strong></div>`).join('')}</div>` : '<div class="empty">No sessions recorded yet.</div>'; }
function streak() { const set = new Set(activeSessions().map(s => key(s.started))); let n = 0, d = new Date(); while (set.has(key(d))) { n++; d.setDate(d.getDate() - 1); } return n; }
function treeSvg(p) { const leaves = Math.round(10 + p * 55); return `<svg viewBox="0 0 360 400"><defs><radialGradient id="treebg"><stop stop-color="#173828"/><stop offset="1" stop-color="#08131c"/></radialGradient></defs><circle cx="180" cy="205" r="155" fill="url(#treebg)" opacity=".72"/><path d="M180 350 Q160 280 180 170" stroke="#866243" stroke-width="18" fill="none" stroke-linecap="round"/><path d="M180 260 Q125 220 100 175 M180 245 Q230 205 255 160 M180 210 Q145 175 125 130 M180 200 Q215 160 235 120" stroke="#5d946e" stroke-width="7" fill="none" stroke-linecap="round"/>${Array.from({ length: leaves }, (_, i) => { const a = i * 2.399, rad = 35 + (i % 9) * 10, x = 180 + Math.cos(a) * rad, y = 135 + Math.sin(a) * rad * .7; return `<circle cx="${x}" cy="${y}" r="${6 + (i % 4) * 2}" fill="${i % 3 === 0 ? '#75d49a' : '#3e9c68'}"/>`; }).join('')}<circle cx="180" cy="350" r="24" fill="#6d4c34"/></svg>`; }

function syncNav() { document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.page === page)); }

function bindNav() {
  document.querySelectorAll('#nav button').forEach(b => b.onclick = () => { page = b.dataset.page; syncNav(); render(); });
  $('#quickTimer').onclick = () => { if (inFriendMode()) { page = 'friends'; } else { page = 'timer'; } syncNav(); render(); };
  $('#backup').onclick = async () => {
    if (!authToken) return toast('Please login first.');
    try {
      await callApi(window.studyAPI.backup, { token: authToken });
      toast('Backup created.');
    } catch (e) { toast(e.message); }
  };
  $('#restore').onclick = async () => {
    if (!authToken) return toast('Please login first.');
    try {
      const restored = await callApi(window.studyAPI.restore, { token: authToken });
      if (restored) {
        myData = restored;
        friendView = null;
        selectedSubject = subjectsFor(myData)[0] || '';
        toast('Restore complete.');
        render();
      }
    } catch (e) { toast(e.message); }
  };
}

(async () => {
  bindNav();
  if (authToken) {
    try {
      await loadSelfData();
    } catch {
      authToken = '';
      localStorage.removeItem('pt.authToken');
    }
  }
  render();
})();
