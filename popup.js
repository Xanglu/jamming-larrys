'use strict';

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const el = {
  idle: document.getElementById('idle-view'),
  active: document.getElementById('active-view'),
  cards: document.querySelector('.cards'),
  hostBtn: document.getElementById('host-btn'),
  listenBtn: document.getElementById('listen-btn'),
  joinForm: document.getElementById('join-form'),
  code: document.getElementById('code'),
  joinBtn: document.getElementById('join-btn'),
  backBtn: document.getElementById('back-btn'),
  dot: document.getElementById('dot'),
  statusText: document.getElementById('status-text'),
  roomCode: document.getElementById('room-code'),
  copyBtn: document.getElementById('copy-btn'),
  roleNote: document.getElementById('role-note'),
  leaveBtn: document.getElementById('leave-btn'),
  error: document.getElementById('error'),
};

let current = null;
let busy = false;
let pollTimer = 0;
let view = 'cards'; // which idle panel is showing: 'cards' | 'join'

function randomCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function normalizeCode(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12);
}

function formatCode(code) {
  return String(code || '').toUpperCase();
}

function send(message) {
  return chrome.runtime.sendMessage({target: 'bg', ...message});
}

function showError(message) {
  el.error.textContent = message;
  el.error.hidden = !message;
}

function setBusy(value) {
  busy = value;
  el.hostBtn.disabled = value;
  el.listenBtn.disabled = value;
  el.joinBtn.disabled = value;
}

function statusLine(state) {
  const role = state.session?.role;
  const peers = state.peers || 0;

  if (state.conflict) return {text: 'Role conflict', tone: 'error'};
  if (state.status === 'error') return {text: state.message || 'Connection error', tone: 'error'};
  if (state.status === 'connecting') return {text: 'Connecting to the relay network…', tone: 'wait'};

  if (role === 'host') {
    if (peers > 0) {
      return {
        text: peers === 1 ? 'Listener connected' : `${peers} listeners connected`,
        tone: 'live',
      };
    }
    return {text: 'Waiting for someone to join…', tone: 'wait'};
  }

  if (peers > 0) return {text: 'Connected to the host', tone: 'live'};
  return {text: 'Waiting for the host…', tone: 'wait'};
}

function renderIdleView() {
  el.joinForm.hidden = view !== 'join';
  el.cards.hidden = view === 'join';
}

function render(state) {
  current = state || null;
  const session = state?.session;

  if (!session) {
    el.idle.hidden = false;
    el.active.hidden = true;
    renderIdleView();
    return;
  }

  view = 'cards';
  el.idle.hidden = true;
  el.active.hidden = false;

  const line = statusLine(state);
  el.dot.className = `dot ${line.tone}`;
  el.statusText.textContent = line.text;

  el.roomCode.textContent = formatCode(session.room);
  el.copyBtn.textContent = 'Copy invite';

  if (state.conflict) {
    el.roleNote.textContent =
      session.role === 'host'
        ? 'You are both hosting this room. Leave and rejoin as a listener on one side.'
        : 'You are both listeners in this room. Leave and rejoin as the host on one side.';
  } else if (session.role === 'host') {
    el.roleNote.textContent =
      'Play, pause, seek or switch videos on YouTube — your listener follows. Keep this window open.';
  } else {
    el.roleNote.textContent =
      'Playback is controlled by the host. Keep this window open so the connection stays alive.';
  }

  if (state.status === 'error' && state.message) {
    showError(state.message);
  } else {
    showError('');
  }
}

async function refresh() {
  try {
    const response = await send({type: 'get-state'});
    if (response?.ok) render(response.state);
  } catch {
    /* service worker is starting up; polling will retry */
  }
}

async function start(role, room) {
  if (busy) return;
  setBusy(true);
  showError('');
  try {
    const response = await send({type: 'start', role, room});
    if (!response?.ok) {
      showError(response?.error || 'Could not start the session.');
      return;
    }
    render(response.state);
    if (role === 'host') {
      el.joinForm.hidden = true;
    }
  } finally {
    setBusy(false);
  }
}

el.hostBtn.addEventListener('click', () => {
  start('host', randomCode());
});

el.listenBtn.addEventListener('click', () => {
  view = 'join';
  el.cards.hidden = true;
  el.joinForm.hidden = false;
  el.code.value = '';
  el.code.focus();
});

el.backBtn.addEventListener('click', () => {
  view = 'cards';
  renderIdleView();
  showError('');
});

el.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const room = normalizeCode(el.code.value);
  if (room.length < 4) {
    showError('Enter the room code your host shared with you.');
    el.code.focus();
    return;
  }
  start('listener', room);
});

el.copyBtn.addEventListener('click', async () => {
  const room = formatCode(current?.session?.room);
  if (!room) return;
  const text = `Join me on Listen Along — room code: ${room}\n(YouTube sync extension)`;
  try {
    await navigator.clipboard.writeText(text);
    el.copyBtn.textContent = 'Copied ✓';
    setTimeout(() => {
      el.copyBtn.textContent = 'Copy invite';
    }, 1600);
  } catch {
    showError(`Copy failed. Share this code manually: ${room}`);
  }
});

el.leaveBtn.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    await send({type: 'stop'});
  } finally {
    setBusy(false);
    view = 'cards';
    render({session: null});
    renderIdleView();
    showError('');
    refresh();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target === 'popup' && msg.type === 'state') render(msg.state);
});

refresh();
pollTimer = setInterval(refresh, 1000);
window.addEventListener('unload', () => clearInterval(pollTimer));
