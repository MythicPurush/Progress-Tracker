/* Friends/social enhancements: explicit shared calendar/history and friend management UI. */

async function friendsPage() {
  try {
    const rows = await callApi(window.studyAPI.listFriends, { token: authToken });
    const accepted = rows.filter(r => r.status === 'accepted');
    $('#content').innerHTML = `<div class="page"><div class="card"><div class="cardhead"><div><h3>Friends</h3><div class="muted">Accepted friends can open your calendar and session history. The timer itself is never available in friend view.</div></div><button class="primary small" id="refreshFriends">Refresh</button></div>${accepted.length ? `<div class="tablewrap mt"><table class="table"><thead><tr><th>Name</th><th>Email</th><th>Shared access</th><th>Actions</th></tr></thead><tbody>${accepted.map(r => `<tr><td>${esc(r.display_name)}</td><td>${esc(r.email)}</td><td>${r.sharing_level === 'full' ? 'Calendar + History' : 'Totals only'}</td><td><button class="iconbtn" data-view="${r.id}">View progress</button> <button class="iconbtn danger" data-block="${r.friendship_id}">Block</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty mt">No accepted friends yet. Send a request from Friend Requests.</div>'}</div></div>`;
    $('#refreshFriends').onclick = () => render();
    document.querySelectorAll('[data-view]').forEach(b => b.onclick = async () => {
      try { await loadFriendData(b.dataset.view); page = 'home'; syncNav(); render(); } catch (e) { toast(e.message); }
    });
    document.querySelectorAll('[data-block]').forEach(b => b.onclick = async () => {
      if (!confirm('Block this user?')) return;
      try { await callApi(window.studyAPI.blockFriend, { token: authToken, friendshipId: b.dataset.block }); friendView = null; render(); } catch (e) { toast(e.message); }
    });
  } catch (e) {
    $('#content').innerHTML = `<div class="page"><div class="card"><h3>Friends</h3><div class="muted">${esc(e.message)}</div></div></div>`;
  }
}

async function requestsPage() {
  try {
    const req = await callApi(window.studyAPI.listFriendRequests, { token: authToken });
    $('#content').innerHTML = `<div class="page"><div class="grid g2"><div class="card"><h3>Send friend request</h3><input id="friendEmail" class="modal-input" type="email" placeholder="friend@example.com"><button class="primary mt-10" id="sendReq">Send request</button></div><div class="card"><h3>Find users</h3><input id="searchInput" class="modal-input" type="text" placeholder="email fragment"><div id="searchRes" class="mt-10"></div></div></div><div class="grid g2 mt"><div class="card"><h3>Incoming</h3>${req.incoming.length ? req.incoming.map(r => `<div class="request-row"><div><b>${esc(r.display_name)}</b><small>${esc(r.email)}</small></div><div><button class="iconbtn" data-accept="${r.id}">Accept</button> <button class="iconbtn danger" data-reject="${r.id}">Reject</button></div></div>`).join('') : '<div class="empty">No incoming requests.</div>'}</div><div class="card"><h3>Outgoing</h3>${req.outgoing.length ? req.outgoing.map(r => `<div class="request-row"><div><b>${esc(r.display_name)}</b><small>${esc(r.email)}</small></div><div class="muted">Pending</div></div>`).join('') : '<div class="empty">No pending outgoing requests.</div>'}</div></div></div>`;
    $('#sendReq').onclick = async () => { const email = $('#friendEmail').value.trim(); try { await callApi(window.studyAPI.sendFriendRequest, { token: authToken, email }); toast('Friend request sent.'); render(); } catch (e) { toast(e.message); } };
    let searchTimer;
    $('#searchInput').addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = $('#searchInput').value.trim();
      if (q.length < 3) { $('#searchRes').innerHTML = ''; return; }
      searchTimer = setTimeout(async () => {
        try {
          const res = await callApi(window.studyAPI.searchUsers, { token: authToken, query: q });
          $('#searchRes').innerHTML = res.length ? `<div class="search-list">${res.map(u => `<div><b>${esc(u.display_name)}</b><small>${esc(u.email)}</small><button class="iconbtn" data-email="${esc(u.email)}">Request</button></div>`).join('')}</div>` : '<div class="muted">No matches. Search by email.</div>';
          document.querySelectorAll('[data-email]').forEach(btn => btn.onclick = async () => { try { await callApi(window.studyAPI.sendFriendRequest, { token: authToken, email: btn.dataset.email }); toast('Friend request sent.'); render(); } catch (e) { toast(e.message); } });
        } catch (e) { $('#searchRes').innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
      }, 200);
    });
    document.querySelectorAll('[data-accept]').forEach(b => b.onclick = async () => { try { await callApi(window.studyAPI.respondFriendRequest, { token: authToken, friendshipId: b.dataset.accept, action: 'accept' }); render(); } catch (e) { toast(e.message); } });
    document.querySelectorAll('[data-reject]').forEach(b => b.onclick = async () => { try { await callApi(window.studyAPI.respondFriendRequest, { token: authToken, friendshipId: b.dataset.reject, action: 'reject' }); render(); } catch (e) { toast(e.message); } });
  } catch (e) {
    $('#content').innerHTML = `<div class="page"><div class="card"><h3>Friend Requests</h3><div class="muted">${esc(e.message)}</div></div></div>`;
  }
}

function profilePage() {
  $('#content').innerHTML = `<div class="page"><div class="card"><h3>Profile</h3><div class="grid g2"><div><small class="muted">Email</small><div class="profile-value">${esc(authUser.email)}</div></div><div><small class="muted">Display name</small><input id="displayName" class="modal-input" value="${esc(authUser.display_name)}"></div></div><div class="grid g2 mt"><div><small class="muted">Friend sharing</small><div class="profile-value">Calendar + full session history</div><div class="muted mt-10">Your accepted friends can view your calendar, individual session history, and shared analytics. They cannot start, pause, or control your timer.</div></div><div class="profile-actions"><button class="primary" id="saveProfile">Save profile</button><button id="exitFriendView" ${inFriendMode() ? '' : 'disabled'}>Exit friend view</button><button id="logout">Log out</button></div></div></div><div class="card mt"><h3>Data management</h3><div class="muted">Backup/restore stays per account.</div></div></div>`;
  $('#saveProfile').onclick = async () => {
    try {
      authUser = await callApi(window.studyAPI.updateProfile, { token: authToken, displayName: $('#displayName').value.trim(), sharingLevel: 'full' });
      myData.user = authUser;
      toast('Profile updated. Full friend sharing is enabled.');
      render();
    } catch (e) { toast(e.message); }
  };
  $('#exitFriendView').onclick = () => { friendView = null; page = 'home'; syncNav(); render(); };
  $('#logout').onclick = async () => { try { await callApi(window.studyAPI.logout, { token: authToken }); } catch {} authToken = ''; authUser = null; myData = { user: null, subjects: [], sessions: [] }; friendView = null; localStorage.removeItem('pt.authToken'); render(); };
}
