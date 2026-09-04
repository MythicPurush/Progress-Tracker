const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const LEGACY_DEFAULT_SUBJECTS = ['Mathematics', 'C++', 'DSA'];
const validSharingLevels = new Set(['full', 'totals']);
const validFriendActions = new Set(['accept', 'reject', 'block']);

let db;

function dbPath() {
  return path.join(app.getPath('userData'), 'progress-tracker.db');
}

function legacyDataPath() {
  return path.join(app.getPath('userData'), 'study-data.json');
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID();
}

function withTransaction(work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#07111b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

function initDb() {
  db = new DatabaseSync(dbPath());
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      display_name TEXT NOT NULL,
      sharing_level TEXT NOT NULL DEFAULT 'full',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, name_norm),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      started TEXT NOT NULL,
      seconds INTEGER NOT NULL,
      subject TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS friendships (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL,
      addressee_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(requester_id, addressee_id),
      FOREIGN KEY(requester_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(addressee_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      legacy_imported INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_started ON sessions(user_id, started);
    CREATE INDEX IF NOT EXISTS idx_friendships_requester_status ON friendships(requester_id, status);
    CREATE INDEX IF NOT EXISTS idx_friendships_addressee_status ON friendships(addressee_id, status);
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_id ON auth_tokens(user_id);
  `);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeName(name) {
  return String(name || '').trim();
}

function normalizeSubjectName(name) {
  return String(name || '').trim();
}

function hashPassword(password, saltHex = crypto.randomBytes(16).toString('hex')) {
  const salt = Buffer.from(saltHex, 'hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt: saltHex, hash };
}

function verifyPassword(password, saltHex, expectedHash) {
  const { hash } = hashPassword(password, saltHex);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

function issueToken(userId) {
  const token = crypto.randomBytes(48).toString('hex');
  const createdAt = nowIso();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  db.prepare('INSERT INTO auth_tokens(token, user_id, created_at, expires_at) VALUES(?, ?, ?, ?)').run(token, userId, createdAt, expiresAt);
  return token;
}

function cleanExpiredTokens() {
  db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(Date.now());
}

function getUserByToken(token) {
  cleanExpiredTokens();
  const auth = db.prepare('SELECT token, user_id FROM auth_tokens WHERE token = ?').get(String(token || ''));
  if (!auth) throw new Error('Unauthorized');
  const user = db.prepare('SELECT id, email, display_name, sharing_level, created_at FROM users WHERE id = ?').get(auth.user_id);
  if (!user) throw new Error('Unauthorized');
  return user;
}

const rateLimitState = new Map();
function enforceRateLimit(key, windowMs, maxCount) {
  const now = Date.now();
  const bucket = rateLimitState.get(key) || [];
  const filtered = bucket.filter(ts => now - ts <= windowMs);
  if (filtered.length >= maxCount) {
    throw new Error('Too many requests. Please wait and try again.');
  }
  filtered.push(now);
  rateLimitState.set(key, filtered);
}

function ensureUserSettings(userId) {
  const existing = db.prepare('SELECT user_id FROM user_settings WHERE user_id = ?').get(userId);
  if (!existing) {
    const now = nowIso();
    db.prepare('INSERT INTO user_settings(user_id, legacy_imported, created_at, updated_at) VALUES(?, 0, ?, ?)').run(userId, now, now);
  }
}

function createDefaultSubjects(userId) {
  const now = nowIso();
  const insert = db.prepare('INSERT OR IGNORE INTO subjects(id, user_id, name, name_norm, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)');
  for (const subject of LEGACY_DEFAULT_SUBJECTS) {
    insert.run(newId(), userId, subject, subject.toLowerCase(), now, now);
  }
}

function loadLegacyData() {
  try {
    return JSON.parse(fs.readFileSync(legacyDataPath(), 'utf8'));
  } catch {
    return null;
  }
}

function migrateLegacyDataIfNeeded(userId) {
  ensureUserSettings(userId);
  const settings = db.prepare('SELECT legacy_imported FROM user_settings WHERE user_id = ?').get(userId);
  if (settings && settings.legacy_imported === 1) return;

  const hasExisting = db.prepare('SELECT EXISTS(SELECT 1 FROM sessions WHERE user_id = ?) as has_sessions').get(userId).has_sessions === 1;
  const hasSubjects = db.prepare('SELECT EXISTS(SELECT 1 FROM subjects WHERE user_id = ?) as has_subjects').get(userId).has_subjects === 1;
  if (hasExisting || hasSubjects) {
    db.prepare('UPDATE user_settings SET legacy_imported = 1, updated_at = ? WHERE user_id = ?').run(nowIso(), userId);
    return;
  }

  const legacy = loadLegacyData();
  if (!legacy || typeof legacy !== 'object') {
    createDefaultSubjects(userId);
    db.prepare('UPDATE user_settings SET legacy_imported = 1, updated_at = ? WHERE user_id = ?').run(nowIso(), userId);
    return;
  }

  withTransaction(() => {
    const now = nowIso();
    const insertSubject = db.prepare('INSERT OR IGNORE INTO subjects(id, user_id, name, name_norm, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)');
    const insertSession = db.prepare('INSERT INTO sessions(id, user_id, started, seconds, subject, created_at) VALUES(?, ?, ?, ?, ?, ?)');

    const subjects = Array.isArray(legacy.subjects) ? legacy.subjects : [];
    for (const raw of subjects) {
      const name = normalizeSubjectName(raw);
      if (!name) continue;
      insertSubject.run(newId(), userId, name, name.toLowerCase(), now, now);
    }

    const sessions = Array.isArray(legacy.sessions) ? legacy.sessions : [];
    for (const s of sessions) {
      if (!s || typeof s !== 'object') continue;
      const started = typeof s.started === 'string' && !Number.isNaN(Date.parse(s.started)) ? s.started : now;
      const seconds = Number.isFinite(Number(s.seconds)) ? Math.max(0, Math.floor(Number(s.seconds))) : 0;
      if (seconds < 1) continue;
      const subject = normalizeSubjectName(s.subject || 'Uncategorized') || 'Uncategorized';
      insertSession.run(typeof s.id === 'string' && s.id ? s.id : newId(), userId, started, seconds, subject, now);
      insertSubject.run(newId(), userId, subject, subject.toLowerCase(), now, now);
    }

    const subCount = db.prepare('SELECT COUNT(*) as c FROM subjects WHERE user_id = ?').get(userId).c;
    if (subCount === 0) createDefaultSubjects(userId);

    db.prepare('UPDATE user_settings SET legacy_imported = 1, updated_at = ? WHERE user_id = ?').run(nowIso(), userId);
  });
}

function getOwnData(userId) {
  const user = db.prepare('SELECT id, email, display_name, sharing_level, created_at FROM users WHERE id = ?').get(userId);
  const subjects = db.prepare('SELECT id, name FROM subjects WHERE user_id = ? ORDER BY created_at ASC').all(userId);
  const sessions = db.prepare('SELECT id, started, seconds, subject FROM sessions WHERE user_id = ? ORDER BY started ASC').all(userId);
  return { user, subjects, sessions };
}

function assertCanViewFriend(viewerId, friendUserId) {
  const relation = db.prepare(`
    SELECT status FROM friendships
    WHERE ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(viewerId, friendUserId, friendUserId, viewerId);

  if (!relation || relation.status !== 'accepted') {
    throw new Error('You can only view accepted friends.');
  }
}

function getFriendTotals(friendUserId) {
  const sessions = db.prepare('SELECT started, seconds, subject FROM sessions WHERE user_id = ?').all(friendUserId);
  const todayKey = new Date().toISOString().slice(0, 10);
  const totalSeconds = sessions.reduce((sum, s) => sum + s.seconds, 0);
  const todaySeconds = sessions.reduce((sum, s) => sum + (String(s.started).slice(0, 10) === todayKey ? s.seconds : 0), 0);
  const last7DaysSeconds = sessions.reduce((sum, s) => {
    const age = Date.now() - new Date(s.started).getTime();
    return sum + (age >= 0 && age <= 7 * 24 * 60 * 60 * 1000 ? s.seconds : 0);
  }, 0);
  const activeDays = new Set(sessions.map(s => String(s.started).slice(0, 10))).size;
  const bySubject = new Map();
  for (const s of sessions) bySubject.set(s.subject, (bySubject.get(s.subject) || 0) + s.seconds);

  return {
    totalSeconds,
    todaySeconds,
    last7DaysSeconds,
    activeDays,
    sessionsCount: sessions.length,
    subjectTotals: Array.from(bySubject.entries()).sort((a, b) => b[1] - a[1])
  };
}

function getFriendData(viewerId, friendUserId) {
  if (viewerId === friendUserId) return getOwnData(viewerId);
  assertCanViewFriend(viewerId, friendUserId);

  const friend = db.prepare('SELECT id, email, display_name, sharing_level, created_at FROM users WHERE id = ?').get(friendUserId);
  if (!friend) throw new Error('Friend not found');

  if (friend.sharing_level === 'totals') {
    return {
      user: friend,
      sharingLevel: 'totals',
      subjects: [],
      sessions: [],
      totals: getFriendTotals(friendUserId)
    };
  }

  const subjects = db.prepare('SELECT id, name FROM subjects WHERE user_id = ? ORDER BY created_at ASC').all(friendUserId);
  const sessions = db.prepare('SELECT id, started, seconds, subject FROM sessions WHERE user_id = ? ORDER BY started ASC').all(friendUserId);
  return { user: friend, sharingLevel: 'full', subjects, sessions };
}

function upsertFriendship(requesterId, addresseeId, status) {
  const now = nowIso();
  const direct = db.prepare('SELECT id FROM friendships WHERE requester_id = ? AND addressee_id = ?').get(requesterId, addresseeId);
  if (direct) {
    db.prepare('UPDATE friendships SET status = ?, updated_at = ? WHERE id = ?').run(status, now, direct.id);
    return direct.id;
  }

  const inverse = db.prepare('SELECT id FROM friendships WHERE requester_id = ? AND addressee_id = ?').get(addresseeId, requesterId);
  if (inverse) {
    db.prepare('UPDATE friendships SET status = ?, updated_at = ?, requester_id = ?, addressee_id = ? WHERE id = ?').run(status, now, requesterId, addresseeId, inverse.id);
    return inverse.id;
  }

  const id = newId();
  db.prepare('INSERT INTO friendships(id, requester_id, addressee_id, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)').run(id, requesterId, addresseeId, status, now, now);
  return id;
}

function sanitizeExport(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid backup file.');

  const subjects = Array.isArray(input.subjects) ? input.subjects : [];
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const cleanSubjects = [];
  const seen = new Set();
  for (const raw of subjects) {
    const name = normalizeSubjectName(typeof raw === 'string' ? raw : raw?.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleanSubjects.push(name);
  }

  const cleanSessions = [];
  for (const s of sessions) {
    if (!s || typeof s !== 'object') continue;
    const seconds = Number.isFinite(Number(s.seconds)) ? Math.max(0, Math.floor(Number(s.seconds))) : 0;
    if (seconds < 1) continue;
    const started = typeof s.started === 'string' && !Number.isNaN(Date.parse(s.started)) ? s.started : nowIso();
    const subject = normalizeSubjectName(s.subject || 'Uncategorized') || 'Uncategorized';
    cleanSessions.push({ id: typeof s.id === 'string' && s.id ? s.id : newId(), started, seconds, subject });
    if (!seen.has(subject.toLowerCase())) {
      seen.add(subject.toLowerCase());
      cleanSubjects.push(subject);
    }
  }

  return {
    version: 3,
    subjects: cleanSubjects,
    sessions: cleanSessions
  };
}

function registerIpcHandlers() {
  ipcMain.handle('auth-signup', (_, payload) => {
    const email = normalizeEmail(payload?.email);
    const displayName = normalizeName(payload?.displayName || email.split('@')[0] || 'User');
    const password = String(payload?.password || '');

    enforceRateLimit(`signup:${email || 'anonymous'}`, 60_000, 10);

    if (!email || !email.includes('@')) throw new Error('Enter a valid email address.');
    if (password.length < 8) throw new Error('Password must be at least 8 characters.');
    if (!displayName) throw new Error('Display name is required.');

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) throw new Error('Account already exists for this email.');

    const userId = newId();
    const now = nowIso();
    const { hash, salt } = hashPassword(password);
    db.prepare(`
      INSERT INTO users(id, email, password_hash, password_salt, display_name, sharing_level, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, 'full', ?, ?)
    `).run(userId, email, hash, salt, displayName, now, now);

    ensureUserSettings(userId);
    migrateLegacyDataIfNeeded(userId);

    const token = issueToken(userId);
    return { token, data: getOwnData(userId) };
  });

  ipcMain.handle('auth-login', (_, payload) => {
    const email = normalizeEmail(payload?.email);
    const password = String(payload?.password || '');

    enforceRateLimit(`login:${email || 'anonymous'}`, 60_000, 15);

    const user = db.prepare('SELECT id, password_hash, password_salt FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      throw new Error('Invalid email or password.');
    }

    migrateLegacyDataIfNeeded(user.id);
    const token = issueToken(user.id);
    return { token, data: getOwnData(user.id) };
  });

  ipcMain.handle('auth-logout', (_, payload) => {
    const token = String(payload?.token || '');
    if (!token) return true;
    db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
    return true;
  });

  ipcMain.handle('auth-me', (_, payload) => {
    const user = getUserByToken(payload?.token);
    return user;
  });

  ipcMain.handle('data-load-self', (_, payload) => {
    const user = getUserByToken(payload?.token);
    return getOwnData(user.id);
  });

  ipcMain.handle('data-load-friend', (_, payload) => {
    const user = getUserByToken(payload?.token);
    const friendUserId = String(payload?.friendUserId || '');
    if (!friendUserId) throw new Error('Missing friend id.');
    return getFriendData(user.id, friendUserId);
  });

  ipcMain.handle('subject-add', (_, payload) => {
    const user = getUserByToken(payload?.token);
    const name = normalizeSubjectName(payload?.name);
    if (!name) throw new Error('Subject name is required.');

    db.prepare('INSERT INTO subjects(id, user_id, name, name_norm, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(newId(), user.id, name, name.toLowerCase(), nowIso(), nowIso());
    return getOwnData(user.id);
  });

  ipcMain.handle('subject-rename', (_, payload) => {
    const user = getUserByToken(payload?.token);
    const subjectId = String(payload?.subjectId || '');
    const name = normalizeSubjectName(payload?.name);
    if (!subjectId || !name) throw new Error('Invalid subject update.');

    const existing = db.prepare('SELECT id, name FROM subjects WHERE id = ? AND user_id = ?').get(subjectId, user.id);
    if (!existing) throw new Error('Subject not found.');

    withTransaction(() => {
      db.prepare('UPDATE subjects SET name = ?, name_norm = ?, updated_at = ? WHERE id = ?').run(name, name.toLowerCase(), nowIso(), subjectId);
      db.prepare('UPDATE sessions SET subject = ? WHERE user_id = ? AND subject = ?').run(name, user.id, existing.name);
    });
    return getOwnData(user.id);
  });

  ipcMain.handle('subject-delete', (_, payload) => {
    const user = getUserByToken(payload?.token);
    const subjectId = String(payload?.subjectId || '');
    if (!subjectId) throw new Error('Missing subject id.');

    const existing = db.prepare('SELECT name FROM subjects WHERE id = ? AND user_id = ?').get(subjectId, user.id);
    if (!existing) throw new Error('Subject not found.');

    db.prepare('DELETE FROM subjects WHERE id = ? AND user_id = ?').run(subjectId, user.id);
    return getOwnData(user.id);
  });

  ipcMain.handle('session-add', (_, payload) => {
    const user = getUserByToken(payload?.token);
    const started = typeof payload?.started === 'string' && !Number.isNaN(Date.parse(payload.started)) ? payload.started : nowIso();
    const seconds = Number.isFinite(Number(payload?.seconds)) ? Math.max(0, Math.floor(Number(payload.seconds))) : 0;
    const subject = normalizeSubjectName(payload?.subject || 'Uncategorized') || 'Uncategorized';
    if (seconds < 1) throw new Error('Session duration must be at least 1 second.');

    withTransaction(() => {
      db.prepare('INSERT INTO sessions(id, user_id, started, seconds, subject, created_at) VALUES(?, ?, ?, ?, ?, ?)')
        .run(newId(), user.id, started, seconds, subject, nowIso());
      db.prepare('INSERT OR IGNORE INTO subjects(id, user_id, name, name_norm, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)')
        .run(newId(), user.id, subject, subject.toLowerCase(), nowIso(), nowIso());
    });

    return getOwnData(user.id);
  });

  ipcMain.handle('session-delete', (_, payload) => {
    const user = getUserByToken(payload?.token);
    const sessionId = String(payload?.sessionId || '');
    if (!sessionId) throw new Error('Missing session id.');

    db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(sessionId, user.id);
    return getOwnData(user.id);
  });

  ipcMain.handle('profile-update', (_, payload) => {
    const user = getUserByToken(payload?.token);
    const displayName = normalizeName(payload?.displayName || user.display_name);
    const sharingLevel = String(payload?.sharingLevel || user.sharing_level);

    if (!displayName) throw new Error('Display name is required.');
    if (!validSharingLevels.has(sharingLevel)) throw new Error('Invalid sharing level.');

    db.prepare('UPDATE users SET display_name = ?, sharing_level = ?, updated_at = ? WHERE id = ?')
      .run(displayName, sharingLevel, nowIso(), user.id);

    return db.prepare('SELECT id, email, display_name, sharing_level, created_at FROM users WHERE id = ?').get(user.id);
  });

  ipcMain.handle('users-search', (_, payload) => {
    const user = getUserByToken(payload?.token);
    const query = normalizeEmail(payload?.query);
    if (!query || query.length < 3) return [];

    return db.prepare(`
      SELECT id, email, display_name
      FROM users
      WHERE id != ? AND email LIKE ?
      ORDER BY email ASC
      LIMIT 10
    `).all(user.id, `%${query}%`);
  });

  ipcMain.handle('friend-request-send', (_, payload) => {
    const user = getUserByToken(payload?.token);
    const email = normalizeEmail(payload?.email);
    if (!email) throw new Error('Enter a valid email.');

    const target = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!target) throw new Error('No user found with that email.');
    if (target.id === user.id) throw new Error('You cannot add yourself.');

    const direct = db.prepare('SELECT id, status FROM friendships WHERE requester_id = ? AND addressee_id = ?').get(user.id, target.id);
    if (direct && direct.status === 'pending') throw new Error('Friend request already sent.');
    if (direct && direct.status === 'accepted') throw new Error('You are already friends.');

    upsertFriendship(user.id, target.id, 'pending');
    return true;
  });

  ipcMain.handle('friend-requests-list', (_, payload) => {
    const user = getUserByToken(payload?.token);

    const incoming = db.prepare(`
      SELECT f.id, f.status, f.created_at, u.id as user_id, u.email, u.display_name
      FROM friendships f
      JOIN users u ON u.id = f.requester_id
      WHERE f.addressee_id = ? AND f.status = 'pending'
      ORDER BY f.created_at DESC
    `).all(user.id);

    const outgoing = db.prepare(`
      SELECT f.id, f.status, f.created_at, u.id as user_id, u.email, u.display_name
      FROM friendships f
      JOIN users u ON u.id = f.addressee_id
      WHERE f.requester_id = ? AND f.status = 'pending'
      ORDER BY f.created_at DESC
    `).all(user.id);

    return { incoming, outgoing };
  });

  ipcMain.handle('friend-request-respond', (_, payload) => {
    const user = getUserByToken(payload?.token);
    const friendshipId = String(payload?.friendshipId || '');
    const action = String(payload?.action || '').toLowerCase();

    if (!friendshipId || !validFriendActions.has(action)) throw new Error('Invalid friend request action.');

    const row = db.prepare('SELECT id, addressee_id, status FROM friendships WHERE id = ?').get(friendshipId);
    if (!row || row.addressee_id !== user.id || row.status !== 'pending') throw new Error('Friend request not found.');

    const mapped = action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'blocked';
    db.prepare('UPDATE friendships SET status = ?, updated_at = ? WHERE id = ?').run(mapped, nowIso(), friendshipId);
    return true;
  });

  ipcMain.handle('friends-list', (_, payload) => {
    const user = getUserByToken(payload?.token);

    return db.prepare(`
      SELECT
        f.id as friendship_id,
        f.status,
        u.id,
        u.email,
        u.display_name,
        u.sharing_level
      FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
      WHERE (f.requester_id = ? OR f.addressee_id = ?)
      ORDER BY u.display_name ASC, u.email ASC
    `).all(user.id, user.id, user.id);
  });

  ipcMain.handle('friend-block', (_, payload) => {
    const user = getUserByToken(payload?.token);
    const friendshipId = String(payload?.friendshipId || '');
    if (!friendshipId) throw new Error('Missing friendship id.');

    const row = db.prepare('SELECT requester_id, addressee_id FROM friendships WHERE id = ?').get(friendshipId);
    if (!row || (row.requester_id !== user.id && row.addressee_id !== user.id)) throw new Error('Friendship not found.');

    const counterpart = row.requester_id === user.id ? row.addressee_id : row.requester_id;
    upsertFriendship(user.id, counterpart, 'blocked');
    return true;
  });

  ipcMain.handle('backup', async (_, payload) => {
    const user = getUserByToken(payload?.token);
    const ownData = getOwnData(user.id);

    const r = await dialog.showSaveDialog({
      title: 'Backup your account data',
      defaultPath: 'ProgressTracker-backup.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });

    if (r.canceled || !r.filePath) return false;

    const backupPayload = {
      version: 3,
      exportedAt: nowIso(),
      account: { email: ownData.user.email, displayName: ownData.user.display_name },
      subjects: ownData.subjects.map(s => s.name),
      sessions: ownData.sessions
    };

    fs.writeFileSync(r.filePath, JSON.stringify(backupPayload, null, 2));
    return true;
  });

  ipcMain.handle('restore', async (_, payload) => {
    const user = getUserByToken(payload?.token);

    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });

    if (r.canceled || !r.filePaths[0]) return null;

    const raw = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    const restored = sanitizeExport(raw);

    withTransaction(() => {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM subjects WHERE user_id = ?').run(user.id);

      const now = nowIso();
      const addSubject = db.prepare('INSERT INTO subjects(id, user_id, name, name_norm, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)');
      for (const name of restored.subjects) {
        addSubject.run(newId(), user.id, name, name.toLowerCase(), now, now);
      }

      const addSession = db.prepare('INSERT INTO sessions(id, user_id, started, seconds, subject, created_at) VALUES(?, ?, ?, ?, ?, ?)');
      for (const session of restored.sessions) {
        addSession.run(session.id, user.id, session.started, session.seconds, session.subject, now);
      }
    });

    return getOwnData(user.id);
  });
}

app.whenReady().then(() => {
  initDb();
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
