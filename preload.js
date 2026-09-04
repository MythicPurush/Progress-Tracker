const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studyAPI', {
  signup: payload => ipcRenderer.invoke('auth-signup', payload),
  login: payload => ipcRenderer.invoke('auth-login', payload),
  logout: payload => ipcRenderer.invoke('auth-logout', payload),
  me: payload => ipcRenderer.invoke('auth-me', payload),

  loadSelf: payload => ipcRenderer.invoke('data-load-self', payload),
  loadFriend: payload => ipcRenderer.invoke('data-load-friend', payload),

  addSubject: payload => ipcRenderer.invoke('subject-add', payload),
  renameSubject: payload => ipcRenderer.invoke('subject-rename', payload),
  deleteSubject: payload => ipcRenderer.invoke('subject-delete', payload),

  addSession: payload => ipcRenderer.invoke('session-add', payload),
  deleteSession: payload => ipcRenderer.invoke('session-delete', payload),

  updateProfile: payload => ipcRenderer.invoke('profile-update', payload),

  searchUsers: payload => ipcRenderer.invoke('users-search', payload),
  sendFriendRequest: payload => ipcRenderer.invoke('friend-request-send', payload),
  listFriendRequests: payload => ipcRenderer.invoke('friend-requests-list', payload),
  respondFriendRequest: payload => ipcRenderer.invoke('friend-request-respond', payload),
  listFriends: payload => ipcRenderer.invoke('friends-list', payload),
  blockFriend: payload => ipcRenderer.invoke('friend-block', payload),

  backup: payload => ipcRenderer.invoke('backup', payload),
  restore: payload => ipcRenderer.invoke('restore', payload)
});
