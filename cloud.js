const fs = require('fs');
const path = require('path');

// Put your Supabase project URL + publishable/anon key in supabase-config.json.
// Never put a service_role key in this file or in the app.
function loadConfig() {
  try {
    const p = path.join(__dirname, 'supabase-config.json');
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    const url = String(c.url || '').replace(/\/$/, '');
    const key = String(c.publishableKey || c.anonKey || '');
    return url && key && !url.includes('YOUR_PROJECT') && !key.includes('YOUR_') ? { url, key } : null;
  } catch {
    return null;
  }
}

const config = loadConfig();
let session = null;

function configured() { return !!config; }
function setSession(s) { session = s || null; }
function getSession() { return session; }
function tokenFromPayload(payload) {
  const raw = String(payload?.token || '');
  if (!raw) return '';
  try { return JSON.parse(raw).access_token || raw; } catch { return raw; }
}
function authHeaders(token) {
  return { apikey: config.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function request(pathname, options = {}, retry = true) {
  if (!config) throw new Error('Cloud sync is not configured yet.');
  const headers = { apikey: config.key, ...(options.headers || {}) };
  const res = await fetch(`${config.url}${pathname}`, { ...options, headers });
  if (res.status === 401 && retry && session?.refresh_token) {
    try {
      const refreshed = await fetch(`${config.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', headers: { apikey: config.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      if (refreshed.ok) {
        const next = await refreshed.json();
        session = { ...session, ...next };
        return request(pathname, options, false);
      }
    } catch {}
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(body?.msg || body?.message || body?.error_description || body?.error || `Cloud request failed (${res.status})`);
  return body;
}

async function auth(pathname, body) {
  const res = await fetch(`${config.url}${pathname}`, {
    method: 'POST',
    headers: { apikey: config.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(data?.msg || data?.message || data?.error_description || data?.error || 'Authentication failed.');
  if (!data?.access_token && !data?.user) throw new Error('Authentication did not return a valid account.');
  if (data.access_token) session = data;
  return data;
}

async function profile(token) {
  const rows = await request(`/rest/v1/profiles?select=id,email,display_name,sharing_level,created_at&id=eq.${encodeURIComponent(userId(token))}`, { headers: authHeaders(token) });
  if (!rows?.[0]) throw new Error('Cloud profile was not created yet. Run the Supabase schema first.');
  return rows[0];
}
function userId(token) {
  const raw = String(token || '');
  try {
    const p = raw.split('.')[1];
    return JSON.parse(Buffer.from(p, 'base64url').toString()).sub;
  } catch { throw new Error('Invalid cloud session.'); }
}

function normalizeRows(rows) { return Array.isArray(rows) ? rows : []; }

async function getOwnData(token) {
  const uid = userId(token);
  const [userRows, subjects, sessions] = await Promise.all([
    request(`/rest/v1/profiles?select=id,email,display_name,sharing_level,created_at&id=eq.${encodeURIComponent(uid)}`, { headers: authHeaders(token) }),
    request(`/rest/v1/subjects?select=id,name,created_at,updated_at&user_id=eq.${encodeURIComponent(uid)}&order=created_at.asc`, { headers: authHeaders(token) }),
    request(`/rest/v1/sessions?select=id,started,seconds,subject,created_at&user_id=eq.${encodeURIComponent(uid)}&order=started.asc`, { headers: authHeaders(token) })
  ]);
  return { user: userRows[0] || null, subjects: normalizeRows(subjects), sessions: normalizeRows(sessions) };
}

function friendFilter(uid) {
  return `or=(and(requester_id.eq.${uid},addressee_id.eq.${uid}),and(requester_id.eq.${uid},addressee_id.eq.${uid}))`;
}

async function searchUsers(token, query) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const encoded = encodeURIComponent(`*${q}*`);
  const [byEmail, byName] = await Promise.all([
    request(`/rest/v1/profiles?select=id,email,display_name&email=ilike.${encoded}&limit=10`, { headers: authHeaders(token) }),
    request(`/rest/v1/profiles?select=id,email,display_name&display_name=ilike.${encoded}&limit=10`, { headers: authHeaders(token) })
  ]);
  const me = userId(token);
  const map = new Map();
  [...normalizeRows(byEmail), ...normalizeRows(byName)].forEach(u => { if (u.id !== me) map.set(u.id, u); });
  return [...map.values()].slice(0, 10);
}

async function sendFriendRequest(token, email) {
  const emailNorm = String(email || '').trim().toLowerCase();
  const rows = await request(`/rest/v1/profiles?select=id,email&id=eq.${encodeURIComponent(emailNorm)}&limit=1`, { headers: authHeaders(token) });
  const target = rows?.[0];
  if (!target) throw new Error('No user found with that email.');
  const me = userId(token);
  if (target.id === me) throw new Error('You cannot add yourself.');

  const existing = await request(`/rest/v1/friendships?select=id,status&or=(and(requester_id.eq.${me},addressee_id.eq.${target.id}),and(requester_id.eq.${target.id},addressee_id.eq.${me}))&limit=1`, { headers: authHeaders(token) });
  if (existing?.[0]?.status === 'accepted') throw new Error('You are already friends.');
  if (existing?.[0]?.status === 'pending') throw new Error('Friend request already exists.');
  await request('/rest/v1/friendships', { method: 'POST', headers: { ...authHeaders(token), Prefer: 'return=minimal' }, body: JSON.stringify({ requester_id: me, addressee_id: target.id, status: 'pending' }) });
  return true;
}

async function listFriendRequests(token) {
  const me = userId(token);
  const [incoming, outgoing] = await Promise.all([
    request(`/rest/v1/friendships?select=id,status,created_at,user:requester_id(id,email,display_name)&addressee_id=eq.${me}&status=eq.pending&order=created_at.desc`, { headers: authHeaders(token) }),
    request(`/rest/v1/friendships?select=id,status,created_at,user:addressee_id(id,email,display_name)&requester_id=eq.${me}&status=eq.pending&order=created_at.desc`, { headers: authHeaders(token) })
  ]);
  return {
    incoming: normalizeRows(incoming).map(x => ({ id: x.id, status: x.status, created_at: x.created_at, user_id: x.user?.id, email: x.user?.email, display_name: x.user?.display_name })),
    outgoing: normalizeRows(outgoing).map(x => ({ id: x.id, status: x.status, created_at: x.created_at, user_id: x.user?.id, email: x.user?.email, display_name: x.user?.display_name }))
  };
}

async function respondFriendRequest(token, friendshipId, action) {
  const mapped = String(action || '').toLowerCase();
  if (!['accept', 'reject', 'block'].includes(mapped)) throw new Error('Invalid friend request action.');
  const status = mapped === 'accept' ? 'accepted' : mapped === 'reject' ? 'rejected' : 'blocked';
  const me = userId(token);
  await request(`/rest/v1/friendships?id=eq.${encodeURIComponent(friendshipId)}&addressee_id=eq.${me}&status=eq.pending`, {
    method: 'PATCH', headers: { ...authHeaders(token), Prefer: 'return=minimal' }, body: JSON.stringify({ status, updated_at: new Date().toISOString() })
  });
  return true;
}

async function listFriends(token) {
  const me = userId(token);
  const rows = await request(`/rest/v1/friendships?select=id,status,requester_id,addressee_id,requester:requester_id(id,email,display_name,sharing_level),addressee:addressee_id(id,email,display_name,sharing_level)&status=eq.accepted&or=(requester_id.eq.${me},addressee_id.eq.${me})`, { headers: authHeaders(token) });
  return normalizeRows(rows).map(f => {
    const u = f.requester_id === me ? f.addressee : f.requester;
    return { friendship_id: f.id, status: f.status, id: u.id, email: u.email, display_name: u.display_name, sharing_level: u.sharing_level };
  });
}

async function loadFriend(token, friendUserId) {
  const uid = userId(token);
  if (uid === friendUserId) return getOwnData(token);
  const friends = await request(`/rest/v1/friendships?select=id&status=eq.accepted&or=(and(requester_id.eq.${uid},addressee_id.eq.${friendUserId}),and(requester_id.eq.${friendUserId},addressee_id.eq.${uid}))&limit=1`, { headers: authHeaders(token) });
  if (!friends?.length) throw new Error('You can only view accepted friends.');
  const users = await request(`/rest/v1/profiles?select=id,email,display_name,sharing_level,created_at&id=eq.${encodeURIComponent(friendUserId)}&limit=1`, { headers: authHeaders(token) });
  const user = users?.[0];
  if (!user) throw new Error('Friend not found.');
  if (user.sharing_level === 'totals') {
    const totals = await request('/rest/v1/rpc/friend_totals', { method: 'POST', headers: authHeaders(token), body: JSON.stringify({ friend_id: friendUserId }) });
    return { user, sharingLevel: 'totals', subjects: [], sessions: [], totals };
  }
  const [subjects, sessions] = await Promise.all([
    request(`/rest/v1/subjects?select=id,name&user_id=eq.${encodeURIComponent(friendUserId)}&order=created_at.asc`, { headers: authHeaders(token) }),
    request(`/rest/v1/sessions?select=id,started,seconds,subject&user_id=eq.${encodeURIComponent(friendUserId)}&order=started.asc`, { headers: authHeaders(token) })
  ]);
  return { user, sharingLevel: 'full', subjects: normalizeRows(subjects), sessions: normalizeRows(sessions) };
}

async function addSubject(token, name) {
  const uid = userId(token);
  const rows = await request('/rest/v1/subjects', { method: 'POST', headers: { ...authHeaders(token), Prefer: 'return=representation' }, body: JSON.stringify({ user_id: uid, name }) });
  return getOwnData(token);
}
async function renameSubject(token, subjectId, name) {
  await request(`/rest/v1/subjects?id=eq.${encodeURIComponent(subjectId)}&user_id=eq.${userId(token)}`, { method: 'PATCH', headers: { ...authHeaders(token), Prefer: 'return=minimal' }, body: JSON.stringify({ name, updated_at: new Date().toISOString() }) });
  return getOwnData(token);
}
async function deleteSubject(token, subjectId) {
  await request(`/rest/v1/subjects?id=eq.${encodeURIComponent(subjectId)}&user_id=eq.${userId(token)}`, { method: 'DELETE', headers: authHeaders(token) });
  return getOwnData(token);
}
async function addSession(token, payload) {
  const uid = userId(token);
  const started = payload?.started || new Date().toISOString();
  const seconds = Math.max(0, Math.floor(Number(payload?.seconds || 0)));
  const subject = String(payload?.subject || 'Uncategorized').trim() || 'Uncategorized';
  if (seconds < 1) throw new Error('Session duration must be at least 1 second.');
  await request('/rest/v1/sessions', { method: 'POST', headers: { ...authHeaders(token), Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: uid, started, seconds, subject }) });
  await request('/rest/v1/subjects', { method: 'POST', headers: { ...authHeaders(token), Prefer: 'return=minimal,resolution=ignore-duplicates' }, body: JSON.stringify({ user_id: uid, name: subject }) });
  return getOwnData(token);
}
async function deleteSession(token, sessionId) {
  await request(`/rest/v1/sessions?id=eq.${encodeURIComponent(sessionId)}&user_id=eq.${userId(token)}`, { method: 'DELETE', headers: authHeaders(token) });
  return getOwnData(token);
}
async function updateProfile(token, payload) {
  const uid = userId(token);
  const body = { display_name: String(payload?.displayName || '').trim(), sharing_level: String(payload?.sharingLevel || 'full') };
  if (!body.display_name) throw new Error('Display name is required.');
  if (!['full', 'totals'].includes(body.sharing_level)) throw new Error('Invalid sharing level.');
  const rows = await request(`/rest/v1/profiles?id=eq.${uid}`, { method: 'PATCH', headers: { ...authHeaders(token), Prefer: 'return=representation' }, body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }) });
  return rows?.[0];
}

async function syncLocalData(token, localData) {
  if (!localData?.user || userId(token) !== localData.user.id && false) {}
  const uid = userId(token);
  const existing = await request(`/rest/v1/sessions?select=id&user_id=eq.${uid}&limit=1`, { headers: authHeaders(token) });
  if (existing?.length || !Array.isArray(localData.sessions) || localData.sessions.length === 0) return getOwnData(token);
  const subjects = (localData.subjects || []).map(s => ({ user_id: uid, name: typeof s === 'string' ? s : s.name })).filter(s => s.name);
  if (subjects.length) await request('/rest/v1/subjects', { method: 'POST', headers: { ...authHeaders(token), Prefer: 'return=minimal,resolution=ignore-duplicates' }, body: JSON.stringify(subjects) });
  const sessions = localData.sessions.map(s => ({ id: s.id, user_id: uid, started: s.started, seconds: s.seconds, subject: s.subject }));
  await request('/rest/v1/sessions', { method: 'POST', headers: { ...authHeaders(token), Prefer: 'return=minimal,resolution=ignore-duplicates' }, body: JSON.stringify(sessions) });
  return getOwnData(token);
}

async function signup({ email, password, displayName }) {
  const data = await auth('/auth/v1/signup', { email, password, options: { data: { display_name: displayName } } });
  return data;
}
async function login({ email, password }) {
  return auth('/auth/v1/token?grant_type=password', { email, password });
}
async function logout() {
  if (session?.access_token) { try { await fetch(`${config.url}/auth/v1/logout`, { method: 'POST', headers: authHeaders(session.access_token) }); } catch {} }
  session = null;
  return true;
}

module.exports = {
  configured, getSession, setSession, tokenFromPayload, signup, login, logout, getOwnData, loadFriend,
  searchUsers, sendFriendRequest, listFriendRequests, respondFriendRequest, listFriends,
  addSubject, renameSubject, deleteSubject, addSession, deleteSession, updateProfile, syncLocalData
};
