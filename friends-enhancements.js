/* Friends/social enhancements: friend discovery by display name and explicit shared calendar/history. */

async function friendsPage() {
  try {
    const rows = await callApi(window.studyAPI.listFriends, { token: authToken });
    const accepted = rows.filter(r => r.status === 'accepted');
    $('#content').innerHTML = `<div class="page"><div class="card"><div class="cardhead"><div><h3>Friends</h3><div class="muted">Friends can see your shared calendar and session history when your sharing setting is "Full progress".</div></div><button class="primary small" id="refreshFriends">Refresh</button></div>${accepted.length ? `<div class="tablewrap mt"><table class="table"><thead><tr><th>Name</th><th>Email</th><th>Sharing</th><th>Actions</th></tr></thead><tbody>${accepted.map(r => `<tr><td>${esc(r.display_name)}</td><td>${esc(r.email)}</td><td>${r.sharing_level === 'full' ? 'Calendar + History' : 'Totals only'}</td><td><button class="iconbtn" data-view="${r.id}">View progress</button> <button class="iconbtn danger" data-block="${r.friendship_id}">Block</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty mt">No accepted friends yet. Send a request from Friend Requests.</div>'}</div></div>`;
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
        friendView = null;
        render();
      } catch (e) { toast(e.message); }
    });
  } catch (e) {
    $('#content').innerHTML = `<div class="page"><div class="card"><h3>Friends</h3><div class="muted">${esc(e.message)}</div></div></div>`;
  }
}

async function requestsPage() {
  try {
    const req = await callApi(window.studyAPI.listFriendRequests, { token: authToken });
    $('#content').innerHTML = `<div class="page"><div class="grid g2"><div class="card"><h3>Send friend request</h3><input id="friendEmail" class="modal-input" type="text" placeholder="friend email or display name"><button class="primary mt-10" id="sendReq">Send request</button><div class="muted mt-10">You can search by full email or display name.</div></div><div class="card"><h3>Find users</h3><input id="searchInput" class="modal-input" type="text" placeholder="email or display name"><div id="searchRes" class="mt-10"></div></div></div><div class="grid g2 mt"><div class="card"><h3>Incoming</h3>${req.incoming.length ? req.incoming.map(r => `<div class="request-row"><div><b>${esc(r.display_name)}</b><small>${esc(r.email)}</small></div><div><button class="iconbtn" data-accept="${r.id}">Accept</button> <button class="iconbtn danger" data-reject="${r.id}">Reject</button></div></div>`).join('') : '<div class="empty">No incoming requests.</div>'}</div><div class="card"><h3>Outgoing</h3>${req.outgoing.length ? req.outgoing.map(r => `<div class="request-row"><div><b>${esc(r.display_name)}</b><small>${esc(r.email)}</small></div><div class="muted">Pending</div></div>`).join('') : '<div class="empty">No pending outgoing requests.</div>'}</div></div></div>`;

    $('#sendReq').onclick = async () => {
      const q = $('#friendEmail').value.trim();
      if (!q) return toast('Enter an email or display name.');
      try {
        const matches = await callApi(window.studyAPI.searchUsers, { token: authToken, query: q });
        if (matches.length === 1) {
          await callApi(window.studyAPI.sendFriendRequest, { token: authToken, email: matches[0].email });
          toast('Friend request sent.');
          render();
        } else if (matches.length > 1) {
          toast('Multiple users found. Use Find users and choose the correct person.');
        } else {
          try {
            await callApi(window.studyAPI.sendFriendRequest, { token: authToken, email: q });
            toast('Friend request sent.');
            render();
          } catch (e) { toast(e.message); }
        }
      } catch (e) { toast(e.message); }
    };

    let searchTimer;
    $('#searchInput').addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = $('#searchInput').value.trim();
      if (q.length < 2) { $('#searchRes').innerHTML = ''; return; }
      searchTimer = setTimeout(async () => {
        try {
          const res = await callApi(window.studyAPI.searchUsers, { token: authToken, query: q });
          $('#searchRes').innerHTML = res.length ? `<div class="search-list">${res.map(u => `<div><b>${esc(u.display_name)}</b><small>${esc(u.email)}</small><button class="iconbtn" data-email="${esc(u.email)}">Request</button></div>`).join('')}</div>` : '<div class="muted">No matches.</div>';
          document.querySelectorAll('[data-email]').forEach(btn => btn.onclick = async () => {
            try { await callApi(window.studyAPI.sendFriendRequest, { token: authToken, email: btn.dataset.email }); toast('Friend request sent.'); render(); } catch (e) { toast(e.message); }
          });
        } catch (e) { $('#searchRes').innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
      }, 200);
    });

    document.querySelectorAll('[data-accept]').forEach(b => b.onclick = async () => { try { await callApi(window.studyAPI.respondFriendRequest, { token: authToken, friendshipId: b.dataset.accept, action: 'accept' }); render(); } catch (e) { toast(e.message); } });
    document.querySelectorAll('[data-reject]').forEach(b => b.onclick = async () => { try { await callApi(window.studyAPI.respondFriendRequest, { token: authToken, friendshipId: b.dataset.reject, action: 'reject' }); render(); } catch (e) { toast(e.message); } });
  } catch (e) {
    $('#content').innerHTML = `<div class="page"><div class="card"><h3>Friend Requests</h3><div class="muted">${esc(e.message)}</div></div></div>`;
  }
}

/* Make the shared-data promise visible: once a friend is accepted, calendar/history
   remain available in friend view; only the timer is blocked. */
