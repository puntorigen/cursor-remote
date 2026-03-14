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

  async prompt(text, placeholder) {
    return this.post('/prompt', { prompt: text, placeholder });
  },

  async query(text, model) {
    return this.post('/query', { prompt: text, model });
  },

  async queryJson(prompt, schema, options) {
    return this.post('/query/json', {
      prompt,
      schema,
      model: options?.model,
      retries: options?.retries,
    });
  },
};

// ── State ──
const state = {
  currentView: 'projects',
  currentProject: null,
  currentProjectClosed: false,
  currentChat: null,
  messages: [],
  messageCount: 0,
  lastModified: 0,
  pollTimer: null,
  pollInterval: 2000,
  activeWorkspace: null,
  activeWorkspaceName: null,
  projectsData: [],
  modes: [],
  models: [],
  currentMode: 'agent',
  currentModel: 'default',
  modesAndModelsLoaded: false,
  serverVersion: null,
};

// ── Markdown setup ──
marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const raw = text || '';
      let highlighted;
      try {
        if (lang && hljs.getLanguage(lang)) {
          highlighted = hljs.highlight(raw, { language: lang }).value;
        } else {
          highlighted = hljs.highlightAuto(raw).value;
        }
      } catch {
        highlighted = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      }
      const langLabel = lang ? `<span class="code-lang">${lang}</span>` : '';
      return `<pre><code class="hljs">${langLabel}${highlighted}</code></pre>`;
    },
  },
});

// ── Navigation ──
const VIEW_DEPTH = { projects: 0, chats: 1, chat: 2, diff: 2 };
let _navTransitioning = false;

function navigate(view, opts = {}) {
  if (_navTransitioning) return;

  const oldView = state.currentView;
  const oldDepth = VIEW_DEPTH[oldView] ?? 0;
  const newDepth = VIEW_DEPTH[view] ?? 0;
  const direction = opts._direction || (newDepth > oldDepth ? 'forward' : newDepth < oldDepth ? 'back' : 'forward');
  const isInitial = oldView === view && !document.querySelector('.view.active');

  if (opts.name) state._navProjectName = opts.name;
  if (opts.preview) state._navChatTitle = opts.preview;

  const oldEl = document.getElementById(`${oldView}View`);
  const newEl = document.getElementById(`${view}View`);

  function doSwitch() {
    document.querySelectorAll('.view').forEach((v) => {
      v.classList.remove('active', 'exit-forward', 'exit-back', 'enter-forward', 'enter-back');
    });
    if (newEl) {
      newEl.classList.add('active');
      if (!isInitial && oldView !== view) {
        newEl.classList.add(direction === 'forward' ? 'enter-forward' : 'enter-back');
        newEl.addEventListener('animationend', () => {
          newEl.classList.remove('enter-forward', 'enter-back');
        }, { once: true });
      }
    }

    const main = document.getElementById('mainContent');
    main.style.overflow = view === 'chat' ? 'hidden' : '';
    state.currentView = view;

    const backBtn = document.getElementById('backBtn');
    const inputBar = document.getElementById('inputBar');
    const headerTitle = document.querySelector('#headerTitle h1');

    backBtn.classList.toggle('hidden', view === 'projects');
    inputBar.classList.toggle('hidden', view !== 'chat');
    document.getElementById('scrollToBottomBtn').classList.remove('visible');

    switch (view) {
      case 'projects':
        headerTitle.textContent = 'Cursor Remote';
        buildBreadcrumb('projects');
        stopPolling();
        loadProjects();
        break;
      case 'chats': {
        headerTitle.textContent = opts.name || state._navProjectName || 'Project';
        state.currentProject = opts.slug || state.currentProject;
        state.modesAndModelsLoaded = false;
        const proj = state.projectsData.find((p) => p.slug === state.currentProject);
        state.currentProjectClosed = proj ? !proj.hasOpenWindow : false;
        buildBreadcrumb('chats', { projectName: headerTitle.textContent });
        stopPolling();
        loadChats(state.currentProject);
        loadGitFiles(state.currentProject);
        break;
      }
      case 'chat':
        headerTitle.textContent = opts.preview || state._navChatTitle || 'Chat';
        state.currentChat = opts.id || state.currentChat;
        buildBreadcrumb('chat', {
          projectName: state._navProjectName,
          chatTitle: headerTitle.textContent,
        });
        loadChat(state.currentProject, state.currentChat);
        fetchModesAndModels();
        break;
      case 'diff':
        headerTitle.textContent = opts.file || 'Diff';
        buildBreadcrumb('diff', {
          projectName: state._navProjectName,
          fileName: opts.file,
        });
        loadDiff(state.currentProject, opts.file, opts.staged);
        break;
    }
    _navTransitioning = false;
  }

  if (!isInitial && oldView !== view && oldEl) {
    _navTransitioning = true;
    const exitClass = direction === 'forward' ? 'exit-forward' : 'exit-back';
    oldEl.classList.add(exitClass);
    setTimeout(() => {
      oldEl.classList.remove('active', exitClass);
      doSwitch();
    }, 150);
  } else {
    doSwitch();
  }
}

function buildBreadcrumb(view, opts = {}) {
  const headerSub = document.getElementById('headerSub');
  if (!headerSub) return;

  switch (view) {
    case 'projects':
      headerSub.innerHTML = state.serverVersion ? `v${state.serverVersion}` : '';
      break;
    case 'chats':
      headerSub.innerHTML =
        `<span class="breadcrumb-segment" data-nav="projects">Projects</span>` +
        `<span class="breadcrumb-sep">/</span>` +
        `<span class="breadcrumb-current">${escHtml(opts.projectName || '')}</span>`;
      break;
    case 'chat':
      headerSub.innerHTML =
        `<span class="breadcrumb-segment" data-nav="projects">Projects</span>` +
        `<span class="breadcrumb-sep">/</span>` +
        `<span class="breadcrumb-segment" data-nav="chats">${escHtml(opts.projectName || '')}</span>` +
        `<span class="breadcrumb-sep">/</span>` +
        `<span class="breadcrumb-current">${escHtml(truncate(opts.chatTitle || '', 20))}</span>`;
      break;
    case 'diff':
      headerSub.innerHTML =
        `<span class="breadcrumb-segment" data-nav="projects">Projects</span>` +
        `<span class="breadcrumb-sep">/</span>` +
        `<span class="breadcrumb-segment" data-nav="chats">${escHtml(opts.projectName || '')}</span>` +
        `<span class="breadcrumb-sep">/</span>` +
        `<span class="breadcrumb-current">${escHtml(opts.fileName || 'Diff')}</span>`;
      break;
  }
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + '...' : str;
}

document.getElementById('headerSub').addEventListener('click', (e) => {
  const segment = e.target.closest('.breadcrumb-segment');
  if (!segment) return;
  const target = segment.dataset.nav;
  if (target === 'projects') {
    navigate('projects', { _direction: 'back' });
  } else if (target === 'chats') {
    navigate('chats', {
      slug: state.currentProject,
      name: state._navProjectName,
      _direction: 'back',
    });
  }
});

function goBack() {
  if (state.currentView === 'chat' || state.currentView === 'diff') {
    navigate('chats', {
      slug: state.currentProject,
      name: state._navProjectName,
      _direction: 'back',
    });
  } else if (state.currentView === 'chats') {
    navigate('projects', { _direction: 'back' });
  }
}

document.getElementById('backBtn').addEventListener('click', goBack);

// ── Swipe-back gesture ──
(function initSwipeBack() {
  const main = document.getElementById('mainContent');
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swiping = false;
  let swipeLocked = false;

  main.addEventListener('touchstart', (e) => {
    if (state.currentView === 'projects' || _navTransitioning) return;
    const touch = e.touches[0];
    if (touch.clientX < 24) {
      swipeStartX = touch.clientX;
      swipeStartY = touch.clientY;
      swiping = false;
      swipeLocked = false;
    }
  }, { passive: true });

  main.addEventListener('touchmove', (e) => {
    if (swipeStartX === 0 || swipeLocked) return;
    const touch = e.touches[0];
    const dx = touch.clientX - swipeStartX;
    const dy = Math.abs(touch.clientY - swipeStartY);

    if (!swiping && dx > 10 && dx > dy) {
      swiping = true;
      const currentView = document.getElementById(`${state.currentView}View`);
      if (currentView) currentView.classList.add('swiping');
    } else if (!swiping && dy > 10) {
      swipeLocked = true;
      return;
    }

    if (swiping && dx > 0) {
      const currentView = document.getElementById(`${state.currentView}View`);
      if (currentView) currentView.style.transform = `translateX(${dx}px)`;
    }
  }, { passive: true });

  main.addEventListener('touchend', (e) => {
    if (!swiping) { swipeStartX = 0; return; }
    const dx = e.changedTouches[0].clientX - swipeStartX;
    const currentView = document.getElementById(`${state.currentView}View`);
    swiping = false;
    swipeStartX = 0;

    if (currentView) currentView.classList.remove('swiping');

    if (dx > window.innerWidth * 0.3) {
      if (currentView) {
        currentView.style.transform = '';
      }
      goBack();
    } else if (currentView) {
      currentView.classList.add('swipe-snap-back');
      currentView.style.transform = 'translateX(0)';
      currentView.addEventListener('transitionend', () => {
        currentView.classList.remove('swipe-snap-back');
        currentView.style.transform = '';
      }, { once: true });
    }
  }, { passive: true });
})();

// ── Logo home shortcut ──
(function initLogoHome() {
  const logo = document.querySelector('.header-logo');
  if (!logo) return;
  let pressTimer = null;

  logo.addEventListener('touchstart', (e) => {
    if (state.currentView === 'projects') return;
    logo.classList.add('pressed');
    pressTimer = setTimeout(() => {
      logo.classList.remove('pressed');
      navigate('projects', { _direction: 'back' });
    }, 400);
  }, { passive: true });

  logo.addEventListener('touchend', () => {
    clearTimeout(pressTimer);
    logo.classList.remove('pressed');
  }, { passive: true });

  logo.addEventListener('touchcancel', () => {
    clearTimeout(pressTimer);
    logo.classList.remove('pressed');
  }, { passive: true });
})();

// ── Animation helpers ──
function staggerItems(container, selector = '.list-item') {
  container.querySelectorAll(selector).forEach((el, i) => {
    el.style.animationDelay = `${Math.min(i * 40, 400)}ms`;
  });
}

// ── Projects ──
async function loadProjects() {
  const list = document.getElementById('projectsList');
  list.innerHTML = '<div class="loading"><div class="spinner"></div>Loading projects...</div>';

  try {
    try {
      const status = await API.get('/status');
      state.activeWorkspace = status.workspace;
      state.activeWorkspaceName = status.workspaceName;
      if (status.version) {
        state.serverVersion = status.version;
        if (state.currentView === 'projects') buildBreadcrumb('projects');
      }
    } catch {}

    const projects = await API.get('/projects');
    if (!Array.isArray(projects) || projects.length === 0) {
      list.innerHTML = `<div class="empty"><h3>No projects found</h3><p>Response: ${escHtml(JSON.stringify(projects).slice(0, 200))}</p></div>`;
      return;
    }

    state.projectsData = projects;

    const realProjects = projects.filter((p) => !p.isOrphan && p.chatCount > 0);
    const emptyProjects = projects.filter((p) => !p.isOrphan && !p.chatCount);
    const orphanChats = projects.filter((p) => p.isOrphan && p.chatCount > 0);

    const activeBanner = state.activeWorkspaceName
      ? `<div class="active-workspace">Connected to: <strong>${escHtml(state.activeWorkspaceName)}</strong> — messages will be sent here</div>`
      : '';

    let html = activeBanner;

    if (realProjects.length > 0) {
      html += realProjects.map((p) => renderProjectItem(p)).join('');
    } else {
      html += '<div class="empty"><h3>No conversations yet</h3><p>Start a chat in Cursor to see it here</p></div>';
    }

    if (orphanChats.length > 0) {
      html += buildCollapsibleSection(
        'orphanToggle', 'orphanList',
        `Standalone chats (${orphanChats.length})`,
        orphanChats.map((p) => renderProjectItem(p)).join('')
      );
    }

    if (emptyProjects.length > 0) {
      html += buildCollapsibleSection(
        'emptyProjectsToggle', 'emptyProjectsList',
        `Projects without chats (${emptyProjects.length})`,
        emptyProjects.map((p) => renderProjectItem(p)).join('')
      );
    }

    list.innerHTML = html;
    staggerItems(list);

    list.querySelectorAll('.section-divider').forEach((toggle) => {
      toggle.addEventListener('click', () => {
        const sectionId = toggle.dataset.section;
        const section = document.getElementById(sectionId);
        const expanded = section.classList.toggle('expanded');
        toggle.classList.toggle('expanded', expanded);
      });
    });

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

function renderProjectItem(p) {
  const timeAgo = p.lastModified ? formatTimeAgo(p.lastModified) : '';
  const chats = p.chatCount ? `${p.chatCount} chat${p.chatCount !== 1 ? 's' : ''}` : 'no chats';
  const isActive = state.activeWorkspace && p.path === state.activeWorkspace;
  const activeClass = isActive ? ' active-project' : '';
  const activeTag = isActive ? '<span class="active-tag">LIVE</span>' : '';
  const openTag = !isActive && p.hasOpenWindow ? '<span class="open-tag">OPEN</span>' : '';
  const closedTag = !isActive && !p.hasOpenWindow && !p.isOrphan ? '<span class="closed-tag">CLOSED</span>' : '';
  return `
    <div class="list-item${activeClass}" data-slug="${p.slug}" data-path="${escAttr(p.path)}" data-name="${escAttr(p.name)}">
      <span class="title">${escHtml(p.name)} ${activeTag}${openTag}${closedTag}</span>
      <span class="meta">${chats}${timeAgo ? ` · ${timeAgo}` : ''}</span>
      <span class="preview">${escHtml(p.path)}</span>
    </div>`;
}

function buildCollapsibleSection(toggleId, sectionId, label, innerHtml) {
  return `
    <div class="section-divider" id="${toggleId}" data-section="${sectionId}">
      <span class="section-label">${label}</span>
      <svg class="section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    </div>
    <div id="${sectionId}" class="collapsed-section">
      ${innerHtml}
    </div>`;
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
        const title = c.title || preview;
        return `
          <div class="list-item" data-id="${c.id}" data-title="${escAttr(title)}" data-preview="${escAttr(preview)}">
            <span class="title">${escHtml(title)}</span>
            <span class="meta">${c.messageCount} messages &middot; ${date}</span>
            ${c.title ? `<span class="preview">${escHtml(preview)}</span>` : ''}
          </div>`;
      })
      .join('');

    staggerItems(list);

    list.querySelectorAll('.list-item').forEach((item) => {
      item.addEventListener('click', () => {
        navigate('chat', { id: item.dataset.id, preview: item.dataset.title });
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
    state.lastModified = Date.now();
    renderMessages(data.messages);
    scrollToBottom();
    startPolling(slug, chatId);
    setTimeout(scrollToBottom, 300);
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

const modeSelect = document.getElementById('modeSelect');
const modelSelect = document.getElementById('modelSelect');
const modeModelBar = document.getElementById('modeModelBar');

const MODE_ICONS = {
  agent: '\u221E',     // ∞
  plan: '\u2713',      // ✓
  chat: '\u{1F4AC}',   // 💬
  debug: '\u{1F41B}',  // 🐛
  triage: '\u{1F680}', // 🚀
  spec: '\u2611',      // ☑
};

async function fetchModesAndModels() {
  if (state.modesAndModelsLoaded) return;
  try {
    const slug = state.currentProject || undefined;
    const data = await API.get(`/modes-and-models${slug ? `?slug=${slug}` : ''}`);
    if (!data.ok) return;

    state.modes = data.modes || [];
    state.models = data.models || [];
    state.currentMode = data.currentMode || 'agent';
    state.currentModel = data.currentModel || 'default';
    state.modesAndModelsLoaded = true;

    populateModeSelect();
    populateModelSelect();
    modeModelBar.classList.remove('hidden');
  } catch {
    // Patch may not support this command yet — hide the bar
  }
}

function populateModeSelect() {
  modeSelect.innerHTML = '';
  const modes = state.modes.length > 0
    ? state.modes
    : [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }, { id: 'chat', name: 'Ask' }];
  for (const m of modes) {
    const opt = document.createElement('option');
    opt.value = m.id;
    const icon = MODE_ICONS[m.id] || '';
    opt.textContent = icon ? `${icon} ${m.name}` : m.name;
    if (m.id === state.currentMode) opt.selected = true;
    modeSelect.appendChild(opt);
  }
}

function populateModelSelect() {
  modelSelect.innerHTML = '';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Default model';
  modelSelect.appendChild(defaultOpt);

  for (const m of state.models) {
    const opt = document.createElement('option');
    opt.value = m.name;
    opt.textContent = m.displayName || m.name;
    if (m.name === state.currentModel) opt.selected = true;
    modelSelect.appendChild(opt);
  }
}

async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text) return;

  if (state.currentProject && state.currentProjectClosed) {
    const launch = confirm(
      'This project has no open Cursor window.\n\nLaunch Cursor on this project first?'
    );
    if (launch) {
      try {
        showToast('Launching Cursor...', 'info');
        await API.post(`/projects/${state.currentProject}/open`, {});
        showToast('Cursor launched — wait a moment for it to load, then send again.', 'success');
      } catch (err) {
        showToast(`Failed to launch: ${err.message}`, 'error');
      }
    }
    return;
  }

  sendBtn.disabled = true;
  msgInput.value = '';
  msgInput.style.height = 'auto';

  const selectedMode = modeSelect.value || undefined;
  const selectedModel = modelSelect.value || undefined;

  const container = document.getElementById('messages');
  const msgDiv = document.createElement('div');
  msgDiv.className = 'msg user pending-remote';
  const modeLabel = selectedMode && selectedMode !== 'agent' ? ` <span class="mode-badge">${selectedMode}</span>` : '';
  const modelLabel = selectedModel ? ` <span class="model-badge">${selectedModel}</span>` : '';
  msgDiv.innerHTML = `<div class="role-label">You (remote)${modeLabel}${modelLabel}</div>${renderMarkdown(text)}`;
  container.appendChild(msgDiv);
  scrollToBottom();

  try {
    const body = {
      message: text,
      slug: state.currentProject || undefined,
      composerId: state.currentChat || undefined,
      mode: selectedMode,
      model: selectedModel,
    };
    const result = await API.post('/send', body);
    if (!result.success) {
      showToast(`Failed: ${result.error || 'Unknown error'}`, 'error');
      msgDiv.remove();
    } else if (result.method === 'clipboard') {
      msgDiv.remove();
      showToast('Patch not applied — message copied to clipboard. Paste into Cursor with Ctrl+V / Cmd+V.', 'warning', 5000);
    } else {
      state.messages.push({ role: 'user', content: text });
      state.messageCount = state.messages.length;
      msgDiv.classList.remove('pending-remote');
      showToast('Sent', 'success');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    msgDiv.remove();
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

function extractImages(text) {
  const imageUrls = [];
  const cleaned = text.replace(/<image_files>[\s\S]*?<\/image_files>/g, (block) => {
    const pathRegex = /\d+\.\s+(\S+)/g;
    let match;
    while ((match = pathRegex.exec(block)) !== null) {
      const absPath = match[1];
      const projectsMatch = absPath.match(/\.cursor\/projects\/([^/]+)\/assets\/(.+)$/);
      if (projectsMatch) {
        const slug = projectsMatch[1];
        const filename = projectsMatch[2];
        imageUrls.push(API._addToken(`/api/projects/${slug}/assets/${encodeURIComponent(filename)}`));
      }
    }
    return '';
  });
  return { cleaned, imageUrls };
}

const PREVIEWABLE_EXTS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg',
  'html', 'txt', 'md', 'json', 'csv',
  'mp4', 'webm', 'mp3', 'wav',
  'xlsx', 'docx', 'pptx',
]);

const INLINE_PREVIEW_EXTS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg',
  'html', 'mp4', 'webm', 'mp3', 'wav',
]);

function fileUrl(relativePath) {
  if (!state.currentProject) return null;
  return API._addToken(
    `/api/projects/${state.currentProject}/files/serve?path=${encodeURIComponent(relativePath)}`
  );
}

/**
 * After markdown rendering, find <code> elements containing file paths and
 * wrap them in clickable links that open in a preview overlay or download.
 */
function linkifyFilePaths(html) {
  return html.replace(
    /<code>([^<]+?\.(\w{1,5}))<\/code>/g,
    (_match, filePath, ext) => {
      if (!PREVIEWABLE_EXTS.has(ext.toLowerCase())) {
        return `<code>${filePath}</code>`;
      }
      const url = fileUrl(filePath);
      if (!url) return `<code>${filePath}</code>`;
      const icon = getFileIcon(ext.toLowerCase());
      return `<a class="file-link" href="${escAttr(url)}" data-ext="${ext.toLowerCase()}" data-path="${escAttr(filePath)}" onclick="openFilePreview(event, this)">${icon}<code>${escHtml(filePath)}</code></a>`;
    }
  );
}

function getFileIcon(ext) {
  if (ext === 'pdf') return '<span class="file-icon">📄</span>';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) return '<span class="file-icon">🖼️</span>';
  if (['mp4', 'webm'].includes(ext)) return '<span class="file-icon">🎬</span>';
  if (['mp3', 'wav'].includes(ext)) return '<span class="file-icon">🎵</span>';
  if (['xlsx'].includes(ext)) return '<span class="file-icon">📊</span>';
  if (['docx'].includes(ext)) return '<span class="file-icon">📝</span>';
  if (['pptx'].includes(ext)) return '<span class="file-icon">📽️</span>';
  return '<span class="file-icon">📎</span>';
}

function renderMarkdown(text) {
  const { cleaned: noImages, imageUrls } = extractImages(text);
  const cleaned = noImages
    .replace(/<user_query>\n?/g, '')
    .replace(/<\/user_query>\n?/g, '')
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/g, '')
    .replace(/<attached_files>[\s\S]*?<\/attached_files>/g, '')
    .replace(/<agent_transcripts>[\s\S]*?<\/agent_transcripts>/g, '')
    .replace(/<open_and_recently_viewed_files>[\s\S]*?<\/open_and_recently_viewed_files>/g, '')
    .replace(/<user_info>[\s\S]*?<\/user_info>/g, '')
    .replace(/^\[Image\]\s*/gm, '')
    .trim();

  let html = '';

  if (imageUrls.length > 0) {
    html += '<div class="msg-images">';
    for (const url of imageUrls) {
      html += `<img class="msg-img" src="${escAttr(url)}" alt="Attached image" loading="lazy" onclick="openLightbox(this.src)">`;
    }
    html += '</div>';
  }

  if (cleaned) {
    try {
      html += linkifyFilePaths(marked.parse(cleaned));
    } catch {
      html += `<p>${escHtml(cleaned)}</p>`;
    }
  }

  return html || '<p><em>(image only)</em></p>';
}

function cleanPreview(text) {
  return text
    .replace(/<user_query>\n?/g, '')
    .replace(/<\/user_query>\n?/g, '')
    .replace(/<image_files>[\s\S]*?<\/image_files>/g, '')
    .replace(/<attached_files>[\s\S]*?<\/attached_files>/g, '')
    .replace(/<agent_transcripts>[\s\S]*?<\/agent_transcripts>/g, '')
    .replace(/<open_and_recently_viewed_files>[\s\S]*?<\/open_and_recently_viewed_files>/g, '')
    .replace(/<user_info>[\s\S]*?<\/user_info>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/^\[Image\]\s*/gm, '')
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

function scrollToBottom(smooth) {
  const container = document.getElementById('messages');
  const doScroll = () => {
    if (smooth) {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    } else {
      container.scrollTop = container.scrollHeight;
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(doScroll));
  setTimeout(doScroll, 150);
  setTimeout(doScroll, 500);
}

function isScrolledToBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

// Floating scroll-to-bottom button
const scrollFab = document.getElementById('scrollToBottomBtn');
scrollFab.addEventListener('click', () => scrollToBottom(true));

document.getElementById('messages').addEventListener('scroll', () => {
  const container = document.getElementById('messages');
  scrollFab.classList.toggle('visible', !isScrolledToBottom(container));
});

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

function showToast(text, type = 'info', duration = 3000) {
  const existing = document.querySelector('.toast:not(.toast-exit)');
  if (existing) {
    existing.classList.add('toast-exit');
    existing.addEventListener('animationend', () => existing.remove(), { once: true });
  }

  const bgColors = {
    error: 'rgba(127, 29, 29, 0.85)',
    success: 'rgba(20, 83, 45, 0.85)',
    warning: 'rgba(120, 53, 15, 0.85)',
    info: 'rgba(30, 41, 59, 0.85)',
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = text;
  toast.style.cssText = `
    position: fixed; bottom: 80px; left: 50%;
    padding: 8px 18px; border-radius: 20px; font-size: 13px; z-index: 100;
    background: ${bgColors[type] || bgColors.info};
    color: white; box-shadow: var(--shadow-md);
    max-width: 90vw; text-align: center;
  `;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, duration);
}

// ── Lightbox / File Preview ──
function openLightbox(src) {
  openFileOverlay(`<img src="${escAttr(src)}" alt="Full size">`);
}

function openFilePreview(event, el) {
  event.preventDefault();
  const url = el.href;
  const ext = el.dataset.ext;
  const filePath = el.dataset.path;
  const baseName = filePath.split('/').pop();

  if (INLINE_PREVIEW_EXTS.has(ext)) {
    let content;
    if (ext === 'pdf') {
      content = `<iframe src="${escAttr(url)}" class="preview-iframe"></iframe>`;
    } else if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) {
      content = `<img src="${escAttr(url)}" alt="${escAttr(baseName)}">`;
    } else if (['mp4', 'webm'].includes(ext)) {
      content = `<video controls autoplay src="${escAttr(url)}"></video>`;
    } else if (['mp3', 'wav'].includes(ext)) {
      content = `<audio controls autoplay src="${escAttr(url)}"></audio>`;
    } else {
      content = `<iframe src="${escAttr(url)}" class="preview-iframe"></iframe>`;
    }
    openFileOverlay(content, baseName, url);
  } else {
    window.open(url, '_blank');
  }
}

function openFileOverlay(content, title, downloadUrl) {
  const existing = document.getElementById('lightbox');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'lightbox';

  const header = title
    ? `<div class="preview-header">
        <span class="preview-title">${escHtml(title)}</span>
        <div class="preview-actions">
          ${downloadUrl ? `<a class="preview-btn" href="${escAttr(downloadUrl)}" target="_blank" download>↓ Open</a>` : ''}
          <button class="preview-btn preview-close">✕</button>
        </div>
      </div>`
    : '';

  overlay.innerHTML = `${header}<div class="preview-body">${content}</div>`;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.classList.contains('preview-close')) {
      overlay.remove();
    }
  });
  const closeBtn = overlay.querySelector('.preview-close');
  if (closeBtn) closeBtn.addEventListener('click', () => overlay.remove());

  document.body.appendChild(overlay);
}

// ── Init ──
navigate('projects');
