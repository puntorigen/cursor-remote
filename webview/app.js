/* global TOKEN, marked, hljs */

const API = {
  _addToken(url) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}token=${encodeURIComponent(TOKEN)}`;
  },

  async get(path) {
    const url = this._addToken(`/api${path}`);
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  },

  async post(path, body) {
    const url = this._addToken(`/api${path}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  },
};

// ── State ──
const state = {
  currentView: 'projects',
  currentProject: null,
  currentChat: null,
  messages: [],
  messageCount: 0,
  lastModified: 0,
  pollTimer: null,
  pollInterval: 2000,
  activeWorkspace: null,
  activeWorkspaceName: null,
};

// ── Markdown setup ──
marked.setOptions({
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
  gfm: true,
});

// ── Navigation ──
function navigate(view, opts = {}) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const el = document.getElementById(`${view}View`);
  if (el) el.classList.add('active');

  state.currentView = view;

  const backBtn = document.getElementById('backBtn');
  const inputBar = document.getElementById('inputBar');
  const headerTitle = document.querySelector('#headerTitle h1');
  const headerSub = document.getElementById('headerSub');

  backBtn.classList.toggle('hidden', view === 'projects');
  inputBar.classList.toggle('hidden', view !== 'chat');

  switch (view) {
    case 'projects':
      headerTitle.textContent = 'Cursor Remote';
      headerSub.textContent = '';
      stopPolling();
      loadProjects();
      break;
    case 'chats':
      headerTitle.textContent = opts.name || 'Project';
      headerSub.textContent = opts.path || '';
      state.currentProject = opts.slug;
      stopPolling();
      loadChats(opts.slug);
      loadGitFiles(opts.slug);
      break;
    case 'chat':
      headerTitle.textContent = opts.preview || 'Chat';
      headerSub.textContent = '';
      state.currentChat = opts.id;
      loadChat(state.currentProject, opts.id);
      break;
    case 'diff':
      headerTitle.textContent = opts.file || 'Diff';
      headerSub.textContent = '';
      loadDiff(state.currentProject, opts.file, opts.staged);
      break;
  }
}

document.getElementById('backBtn').addEventListener('click', () => {
  if (state.currentView === 'chat' || state.currentView === 'diff') {
    navigate('chats', {
      slug: state.currentProject,
      name: document.querySelector('#headerTitle h1').textContent,
    });
  } else if (state.currentView === 'chats') {
    navigate('projects');
  }
});

// ── Projects ──
async function loadProjects() {
  const list = document.getElementById('projectsList');
  list.innerHTML = '<div class="loading"><div class="spinner"></div>Loading projects...</div>';

  try {
    // Fetch active workspace info
    try {
      const status = await API.get('/status');
      state.activeWorkspace = status.workspace;
      state.activeWorkspaceName = status.workspaceName;
    } catch {}

    const projects = await API.get('/projects');
    if (!Array.isArray(projects) || projects.length === 0) {
      list.innerHTML = `<div class="empty"><h3>No projects found</h3><p>Response: ${escHtml(JSON.stringify(projects).slice(0, 200))}</p></div>`;
      return;
    }

    // Show active workspace banner
    const activeBanner = state.activeWorkspaceName
      ? `<div class="active-workspace">Connected to: <strong>${escHtml(state.activeWorkspaceName)}</strong> — messages will be sent here</div>`
      : '';

    list.innerHTML = activeBanner + projects
      .map(
        (p) => {
          const timeAgo = p.lastModified ? formatTimeAgo(p.lastModified) : '';
          const chats = p.chatCount ? `${p.chatCount} chat${p.chatCount !== 1 ? 's' : ''}` : 'no chats';
          const isActive = state.activeWorkspace && p.path === state.activeWorkspace;
          const activeClass = isActive ? ' active-project' : '';
          const activeTag = isActive ? '<span class="active-tag">LIVE</span>' : '';
          return `
        <div class="list-item${activeClass}" data-slug="${p.slug}" data-path="${escAttr(p.path)}" data-name="${escAttr(p.name)}">
          <span class="title">${escHtml(p.name)} ${activeTag}</span>
          <span class="meta">${chats}${timeAgo ? ` · ${timeAgo}` : ''}</span>
          <span class="preview">${escHtml(p.path)}</span>
        </div>`;
        }
      )
      .join('');

    list.querySelectorAll('.list-item').forEach((item) => {
      item.addEventListener('click', () => {
        navigate('chats', {
          slug: item.dataset.slug,
          name: item.dataset.name,
          path: item.dataset.path,
        });
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="empty"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`;
  }
}

// ── Chats ──
async function loadChats(slug) {
  const list = document.getElementById('chatsList');
  list.innerHTML = '<div class="loading"><div class="spinner"></div>Loading chats...</div>';

  try {
    const chats = await API.get(`/projects/${slug}/chats`);
    if (chats.length === 0) {
      list.innerHTML = '<div class="empty"><h3>No conversations</h3><p>Start a chat in Cursor to see it here</p></div>';
      return;
    }
    list.innerHTML = chats
      .map((c) => {
        const date = new Date(c.lastModified).toLocaleString();
        const preview = cleanPreview(c.firstMessage);
        return `
          <div class="list-item" data-id="${c.id}" data-preview="${escAttr(preview)}">
            <span class="preview">${escHtml(preview)}</span>
            <span class="meta">${c.messageCount} messages &middot; ${date}</span>
          </div>`;
      })
      .join('');

    list.querySelectorAll('.list-item').forEach((item) => {
      item.addEventListener('click', () => {
        navigate('chat', { id: item.dataset.id, preview: item.dataset.preview });
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="empty"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`;
  }
}

// ── Chat Messages ──
async function loadChat(slug, chatId) {
  const container = document.getElementById('messages');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading conversation...</div>';

  try {
    const data = await API.get(`/projects/${slug}/chats/${chatId}`);
    state.messages = data.messages;
    state.messageCount = data.messages.length;
    renderMessages(data.messages);
    scrollToBottom();
    startPolling(slug, chatId);
  } catch (err) {
    container.innerHTML = `<div class="empty"><h3>Error</h3><p>${escHtml(err.message)}</p></div>`;
  }
}

function renderMessages(messages) {
  const container = document.getElementById('messages');
  container.innerHTML = messages
    .map((m) => {
      const roleLabel = m.role === 'user' ? 'You' : 'Cursor';
      const rendered = renderMarkdown(m.content);
      return `
        <div class="msg ${m.role}">
          <div class="role-label">${roleLabel}</div>
          ${rendered}
        </div>`;
    })
    .join('');
}

function appendMessages(newMessages) {
  const container = document.getElementById('messages');
  const wasAtBottom = isScrolledToBottom(container);

  for (const m of newMessages) {
    const roleLabel = m.role === 'user' ? 'You' : 'Cursor';
    const rendered = renderMarkdown(m.content);
    const div = document.createElement('div');
    div.className = `msg ${m.role}`;
    div.innerHTML = `<div class="role-label">${roleLabel}</div>${rendered}`;
    container.appendChild(div);
  }

  if (wasAtBottom) scrollToBottom();
}

// ── Polling ──
function startPolling(slug, chatId) {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    try {
      const poll = await API.get(`/projects/${slug}/chats/${chatId}/poll`);
      if (poll.lastModified > state.lastModified) {
        state.lastModified = poll.lastModified;
        const data = await API.get(
          `/projects/${slug}/chats/${chatId}?since=${state.messageCount}`
        );
        if (data.messages.length > 0) {
          state.messages.push(...data.messages);
          state.messageCount = state.messages.length;
          appendMessages(data.messages);
        }
      }
    } catch {}
  }, state.pollInterval);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

// ── Git Files ──
async function loadGitFiles(slug) {
  const list = document.getElementById('gitFilesList');
  const badge = document.getElementById('filesBadge');

  try {
    const data = await API.get(`/projects/${slug}/files`);
    if (data.changes.length === 0) {
      list.innerHTML = '<div class="empty"><h3>Clean working tree</h3></div>';
      badge.classList.add('hidden');
      return;
    }

    badge.textContent = data.changes.length;
    badge.classList.remove('hidden');

    list.innerHTML = data.changes
      .map(
        (f) => `
        <div class="file-item" data-path="${escAttr(f.path)}" data-staged="${f.staged}">
          <span class="file-status ${f.status}"></span>
          <span>${escHtml(f.path)}</span>
          <span class="file-ops">${f.staged ? 'staged' : f.status}</span>
        </div>`
      )
      .join('');

    list.querySelectorAll('.file-item').forEach((item) => {
      item.addEventListener('click', () => {
        navigate('diff', {
          file: item.dataset.path,
          staged: item.dataset.staged === 'true',
        });
      });
    });
  } catch {
    list.innerHTML = '<div class="empty"><h3>Not a git repository</h3></div>';
    badge.classList.add('hidden');
  }
}

// ── AI Files ──
async function loadAiFiles(slug, chatId) {
  const list = document.getElementById('aiFilesList');
  try {
    const files = await API.get(`/projects/${slug}/chats/${chatId}/files`);
    if (files.length === 0) {
      list.innerHTML = '<div class="empty"><h3>No files modified</h3></div>';
      return;
    }
    list.innerHTML = files
      .map(
        (f) => `
        <div class="file-item" data-path="${escAttr(f.path)}">
          <span class="file-status modified"></span>
          <span>${escHtml(f.path)}</span>
          <span class="file-ops">${f.operations.join(', ')}</span>
        </div>`
      )
      .join('');
  } catch {
    list.innerHTML = '<div class="empty"><h3>Error loading AI files</h3></div>';
  }
}

// ── Diff ──
async function loadDiff(slug, filePath, staged) {
  const content = document.getElementById('diffContent');
  const title = document.getElementById('diffTitle');
  title.textContent = filePath;
  content.textContent = 'Loading...';

  try {
    const data = await API.get(
      `/projects/${slug}/files/diff?path=${encodeURIComponent(filePath)}&staged=${staged}`
    );
    if (!data.diff) {
      content.innerHTML = '<span class="diff-hunk">No diff available (new/untracked file)</span>';
      return;
    }
    content.innerHTML = data.diff
      .split('\n')
      .map((line) => {
        if (line.startsWith('+') && !line.startsWith('+++'))
          return `<span class="diff-add">${escHtml(line)}</span>`;
        if (line.startsWith('-') && !line.startsWith('---'))
          return `<span class="diff-del">${escHtml(line)}</span>`;
        if (line.startsWith('@@'))
          return `<span class="diff-hunk">${escHtml(line)}</span>`;
        return escHtml(line);
      })
      .join('\n');
  } catch (err) {
    content.textContent = `Error: ${err.message}`;
  }
}

// ── Send Message ──
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');

sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

msgInput.addEventListener('input', () => {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
});

async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text) return;

  sendBtn.disabled = true;
  msgInput.value = '';
  msgInput.style.height = 'auto';

  const container = document.getElementById('messages');
  const msgDiv = document.createElement('div');
  msgDiv.className = 'msg user';
  msgDiv.innerHTML = `<div class="role-label">You (remote)</div>${renderMarkdown(text)}`;
  container.appendChild(msgDiv);
  scrollToBottom();

  try {
    const result = await API.post('/send', { message: text });
    if (!result.success) {
      showToast(`Failed: ${result.error || 'Unknown error'}`, 'error');
    } else {
      const label = result.method === 'chatOpenNew' ? 'Sent (new chat)' : 'Sent (continuing chat)';
      showToast(label, 'success');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }

  sendBtn.disabled = false;
  msgInput.focus();
}

// ── Tabs ──
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const parent = tab.closest('.view');
    parent.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    parent.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    const content = document.getElementById(`${tab.dataset.tab}Tab`);
    if (content) content.classList.add('active');
  });
});

document.querySelectorAll('.sub-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const parent = tab.closest('.tab-content');
    parent.querySelectorAll('.sub-tab').forEach((t) => t.classList.remove('active'));
    parent.querySelectorAll('.sub-tab-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    const content = document.getElementById(`${tab.dataset.subtab}Changes`);
    if (content) content.classList.add('active');
  });
});

// ── Helpers ──
function renderMarkdown(text) {
  const cleaned = text
    .replace(/<user_query>\n?/g, '')
    .replace(/<\/user_query>\n?/g, '')
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/g, '');
  try {
    return marked.parse(cleaned);
  } catch {
    return `<p>${escHtml(cleaned)}</p>`;
  }
}

function cleanPreview(text) {
  return text
    .replace(/<user_query>\n?/g, '')
    .replace(/<\/user_query>\n?/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function escHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function escAttr(s) {
  return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function scrollToBottom() {
  const container = document.getElementById('messages');
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}

function isScrolledToBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function showToast(text, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = text;
  toast.style.cssText = `
    position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
    padding: 8px 18px; border-radius: 20px; font-size: 13px; z-index: 100;
    background: ${type === 'error' ? '#7f1d1d' : type === 'success' ? '#14532d' : '#1e293b'};
    color: white; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ── Init ──
navigate('projects');
