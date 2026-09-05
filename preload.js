const { contextBridge, ipcRenderer } = require('electron');
const cloud = require('./cloud');

let localToken = '';

async function cloudOrLocal(cloudFn, localChannel, payload) {
  if (cloud.configured()) return cloudFn(payload?.token ? cloud.tokenFromPayload(payload) : '', payload);
  return ipcRenderer.invoke(localChannel, payload);
}

async function cloudAuth(kind, payload) {
  const result = kind === 'signup' ? await cloud.signup(payload) : await cloud.login(payload);
  if (!result?.access_token) throw new Error('Cloud account requires email confirmation. Please confirm your email, then log in again.');
  cloud.setSession(result);

  // Keep a local token solely for local backup/restore compatibility.
  try {
    const local = kind === 'signup'
      ? await ipcRenderer.invoke('auth-signup', payload)
      : await ipcRenderer.invoke('auth-login', payload);
    localToken = local.token;
    try {
      const localData = await ipcRenderer.invoke('data-load-self', { token: localToken });
      const data = await cloud.syncLocalData(result.access_token, localData);
      return { token: JSON.stringify({ access_token: result.access_token, refresh_token: result.refresh_token }), data };
    } catch {
      const data = await cloud.getOwnData(result.access_token);
      return { token: JSON.stringify({ access_token: result.access_token, refresh_token: result.refresh_token }), data };
    }
  } catch {
    const data = await cloud.getOwnData(result.access_token);
    return { token: JSON.stringify({ access_token: result.access_token, refresh_token: result.refresh_token }), data };
  }
}

function cloudToken(payload) { return cloud.tokenFromPayload(payload); }

contextBridge.exposeInMainWorld('studyAPI', {
  signup: payload => cloud.configured() ? cloudAuth('signup', payload) : ipcRenderer.invoke('auth-signup', payload).then(r => { localToken = r.token; return r; }),
  login: payload => cloud.configured() ? cloudAuth('login', payload) : ipcRenderer.invoke('auth-login', payload).then(r => { localToken = r.token; return r; }),
  logout: async payload => {
    if (cloud.configured()) { await cloud.logout(); localToken = ''; return true; }
    localToken = '';
    return ipcRenderer.invoke('auth-logout', payload);
  },
  me: payload => cloud.configured() ? cloud.getOwnData(cloudToken(payload)).then(x => x.user) : ipcRenderer.invoke('auth-me', payload),

  loadSelf: payload => cloud.configured() ? cloud.getOwnData(cloudToken(payload)) : ipcRenderer.invoke('data-load-self', payload),
  loadFriend: payload => cloud.configured() ? cloud.loadFriend(cloudToken(payload), payload.friendUserId) : ipcRenderer.invoke('data-load-friend', payload),

  addSubject: payload => cloud.configured() ? cloud.addSubject(cloudToken(payload), payload.name) : ipcRenderer.invoke('subject-add', payload),
  renameSubject: payload => cloud.configured() ? cloud.renameSubject(cloudToken(payload), payload.subjectId, payload.name) : ipcRenderer.invoke('subject-rename', payload),
  deleteSubject: payload => cloud.configured() ? cloud.deleteSubject(cloudToken(payload), payload.subjectId) : ipcRenderer.invoke('subject-delete', payload),

  addSession: payload => cloud.configured() ? cloud.addSession(cloudToken(payload), payload) : ipcRenderer.invoke('session-add', payload),
  deleteSession: payload => cloud.configured() ? cloud.deleteSession(cloudToken(payload), payload.sessionId) : ipcRenderer.invoke('session-delete', payload),

  updateProfile: payload => cloud.configured() ? cloud.updateProfile(cloudToken(payload), payload) : ipcRenderer.invoke('profile-update', payload),

  searchUsers: payload => cloud.configured() ? cloud.searchUsers(cloudToken(payload), payload.query) : ipcRenderer.invoke('users-search', payload),
  sendFriendRequest: payload => cloud.configured() ? cloud.sendFriendRequest(cloudToken(payload), payload.email) : ipcRenderer.invoke('friend-request-send', payload),
  listFriendRequests: payload => cloud.configured() ? cloud.listFriendRequests(cloudToken(payload)) : ipcRenderer.invoke('friend-requests-list', payload),
  respondFriendRequest: payload => cloud.configured() ? cloud.respondFriendRequest(cloudToken(payload), payload.friendshipId, payload.action) : ipcRenderer.invoke('friend-request-respond', payload),
  listFriends: payload => cloud.configured() ? cloud.listFriends(cloudToken(payload)) : ipcRenderer.invoke('friends-list', payload),
  blockFriend: payload => cloud.configured() ? ipcRenderer.invoke('friend-block', { ...payload, token: localToken }) : ipcRenderer.invoke('friend-block', payload),

  // Backup/restore remain local-file operations and therefore use the local token.
  backup: payload => ipcRenderer.invoke('backup', { ...payload, token: localToken || payload?.token }),
  restore: payload => ipcRenderer.invoke('restore', { ...payload, token: localToken || payload?.token })
});
