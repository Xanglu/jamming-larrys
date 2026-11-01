'use strict';

// Runs on radio.garden. Radio Garden is live radio: there is no seek bar and no
// video id, so a session mirrors the tuned station plus play/pause. The site
// keeps its player in a detached `new Audio()` object, so rg-bridge.js (MAIN
// world) captures it and relays state over postMessage; this script owns the
// session, the sync rules and the on-page UI.

const SITE = 'rg';
const LISTEN_PATH = /^\/listen\/[^/]+\/[^/]+/;
const TAG = 'listen-along-rg';

const S = {
  role: null, // 'host' | 'listener'
  room: null,
  status: 'idle', // idle | connecting | waiting | connected | error
  peers: 0,
  conflict: false,
  message: '',
  remote: null, // {s, title, paused, at}
  station: null, // {path, id, title} reported by the bridge
  media: null, // {paused, volume, src, readyState}
  away: false, // host left the radio, or is on a different site
  otherSite: false,
  applyingUntil: 0,
  blockedUntil: 0,
  navigatingUntil: 0,
  stationChangedAt: 0,
  lastPressAt: 0,
  requestAt: 0,
  hostSendTimer: 0,
  lastToastAt: 0,
  toastTimer: 0,
  ui: null,
};

const now = () => Date.now();
const isApplying = () => Date.now() < S.applyingUntil;
const markApplying = (ms = 1500) => {
  S.applyingUntil = Date.now() + ms;
};

/* ------------------------------------------------------------------ station -- */

// The bridge knows the station the site is actually playing, which is not always
// in the URL (the globe starts playback without navigating). Fall back to the
// URL on first load, before the bridge has seen the channel metadata.
function currentStation() {
  if (S.station?.path) return S.station.path;
  const path = location.pathname;
  return LISTEN_PATH.test(path) ? path : null;
}

function stationTitle() {
  if (S.station?.title) return S.station.title;
  const title = document.querySelector('[data-jest-id^="playBarChannelTitle"]');
  return title?.textContent?.trim() || '';
}

function mediaPaused() {
  return S.media ? Boolean(S.media.paused) : true;
}

/* --------------------------------------------------------------- messaging -- */

function post(message) {
  try {
    return chrome.runtime.sendMessage({target: 'bg', ...message});
  } catch {
    return Promise.resolve();
  }
}

function send(data) {
  if (!S.role || S.conflict || S.peers < 1) return;
  post({type: 'broadcast', data}).catch(() => {});
}

function requestState() {
  if (S.role !== 'listener' || S.conflict) return;
  if (now() - S.requestAt < 1200) return;
  S.requestAt = now();
  send({t: 'request'});
}

function sendFullState() {
  if (S.role !== 'host' || S.conflict) return;
  const path = currentStation();
  if (!path) {
    send({t: 'away'});
    return;
  }
  // A freshly tuned station buffers before it plays, while the previous player
  // has already paused. Report "playing" during that window so listeners start
  // the new station instead of sitting paused waiting for it.
  const switching = S.stationChangedAt > 0 && now() - S.stationChangedAt < 5000;
  send({
    t: 'state',
    site: SITE,
    s: path,
    title: stationTitle(),
    paused: switching ? false : mediaPaused(),
    at: Date.now(),
  });
}

function queueHostState(delay = 80) {
  if (S.role !== 'host' || S.conflict) return;
  clearTimeout(S.hostSendTimer);
  S.hostSendTimer = setTimeout(sendFullState, delay);
}

/* ----------------------------------------------------------------- session -- */

function applySession(state) {
  const previousRole = S.role;
  const previousPeers = S.peers;

  S.role = state?.session?.role || null;
  S.room = state?.session?.room || null;
  S.status = state?.status || 'idle';
  S.peers = state?.peers || 0;
  S.conflict = Boolean(state?.conflict);
  S.message = state?.message || '';

  if (!S.role) {
    teardown();
    return;
  }

  if (S.peers === 0 && previousPeers > 0) {
    S.remote = null;
    S.away = false;
    S.otherSite = false;
  }

  ensureUI();
  renderUI();

  if (previousRole !== S.role) {
    S.remote = null;
    S.away = false;
    S.otherSite = false;
    if (S.role === 'listener') requestState();
  }

  if (S.peers > 0 && previousPeers === 0) {
    if (S.role === 'host') sendFullState();
    else requestState();
  }

  if (S.role === 'listener' && S.remote?.s && S.remote.s !== currentStation()) {
    maybeNavigate(S.remote.s);
  }
}

function teardown() {
  S.remote = null;
  S.station = null;
  S.media = null;
  S.away = false;
  S.otherSite = false;
  if (S.ui) {
    S.ui.root.remove();
    S.ui = null;
  }
}

/* ------------------------------------------------------------ peer traffic -- */

function onPeerMessage(data) {
  if (!data || typeof data !== 'object') return;

  if (data.t === 'request') {
    if (S.role === 'host') sendFullState();
    return;
  }

  if (data.t === 'away') {
    if (S.role === 'listener' && S.remote) {
      S.away = true;
      S.otherSite = false;
      renderUI();
    }
    return;
  }

  if (data.t !== 'state' || S.role !== 'listener' || S.conflict) return;

  // A YouTube host has nothing in common with a radio listener.
  if (data.site && data.site !== SITE) {
    S.otherSite = true;
    S.remote = null;
    S.away = false;
    renderUI();
    return;
  }

  const remote = {
    s: typeof data.s === 'string' ? data.s : '',
    title: typeof data.title === 'string' ? data.title : '',
    paused: Boolean(data.paused),
    at: now(),
  };
  S.remote = remote;
  S.away = false;
  S.otherSite = false;

  if (remote.s && remote.s !== currentStation()) {
    maybeNavigate(remote.s);
    renderUI();
    return;
  }

  applyRemote();
  renderUI();
}

function findStationLink(path) {
  for (const link of document.querySelectorAll('a[data-jest-href], a[href]')) {
    const href = link.getAttribute('data-jest-href') || link.getAttribute('href');
    if (href === path) return link;
  }
  return null;
}

function maybeNavigate(path) {
  if (S.role !== 'listener' || !path) return;
  if (!LISTEN_PATH.test(path)) return;
  if (Date.now() < S.navigatingUntil) return;
  if (currentStation() === path) return;

  S.navigatingUntil = Date.now() + 12_000;

  // If the station is already rendered (the place drawer), clicking its row
  // switches in place. That keeps this document's user activation, so playback
  // can start without the autoplay prompt that a reload would force.
  const link = findStationLink(path);
  if (link) {
    markApplying(4000);
    link.click();
    setTimeout(() => {
      if (S.role !== 'listener' || !S.remote) return;
      if (S.remote.s !== path || currentStation() === path) return;
      location.assign(path);
    }, 2500);
    return;
  }

  location.assign(path);
}

/* --------------------------------------------------------------- playback -- */

function sendCommand(cmd) {
  try {
    window.postMessage({source: TAG, kind: 'cmd', cmd}, location.origin);
  } catch {
    /* ignore */
  }
}

function playBarButton(label) {
  const bar = document.querySelector('[data-jest-id="playBar"]');
  if (!bar) return null;
  return bar.querySelector(`button[aria-label="${label}" i]`);
}

// If a press does not produce audio (autoplay still blocked), stop retrying for
// a while so the tap affordance can show steadily instead of flickering.
function scheduleStartCheck() {
  setTimeout(() => {
    if (S.role !== 'listener' || !S.remote || S.remote.paused) return;
    if (S.media && !S.media.paused) return;
    S.blockedUntil = Date.now() + 8000;
    updatePill();
  }, 2600);
}

function pressPlay(force = false) {
  if (S.role !== 'listener' || !S.remote || S.remote.paused) return false;
  if (!force) {
    if (Date.now() < S.blockedUntil) return false;
    if (Date.now() - S.lastPressAt < 1200) return false;
  }
  S.lastPressAt = Date.now();
  scheduleStartCheck();

  // With a captured element, the bridge can play it directly. Without one the
  // site has never started playback, so use its own play button.
  if (S.media) {
    markApplying(1800);
    sendCommand('play');
    return true;
  }
  const button = playBarButton('play');
  if (button) {
    markApplying(1800);
    button.click();
    return true;
  }
  return false;
}

function pressPause() {
  if (Date.now() - S.lastPressAt < 800) return;
  S.lastPressAt = Date.now();
  markApplying(1500);
  if (S.media) {
    sendCommand('pause');
    return;
  }
  const button = playBarButton('stop');
  if (button) button.click();
}

function applyRemote() {
  if (S.role !== 'listener' || !S.remote || S.conflict) return;

  if (S.remote.s && S.remote.s !== currentStation()) {
    maybeNavigate(S.remote.s);
    return;
  }

  if (S.remote.paused) {
    if (S.media && !S.media.paused && !isApplying()) pressPause();
  } else if ((!S.media || S.media.paused) && !isApplying()) {
    pressPlay();
  }
}

function onMedia(next) {
  const previous = S.media;
  S.media = next;

  if (!next.paused) S.blockedUntil = 0;

  if (S.role === 'listener' && S.remote && !S.conflict && !S.away && !S.otherSite) {
    if (next.paused && !S.remote.paused && previous && !previous.paused && !isApplying()) {
      // The listener paused locally; put playback back under host control.
      markApplying(1500);
      pressPlay(true);
      toast('The host controls playback');
    } else if (!next.paused && S.remote.paused && !isApplying()) {
      markApplying(1500);
      pressPause();
      toast('The host has playback paused');
    }
  }

  if (S.role === 'host' && previous && previous.paused !== next.paused) {
    queueHostState(60);
  }

  updatePill();
}

function onStation(station) {
  if (!station || !LISTEN_PATH.test(station.path)) return;
  const previousPath = S.station?.path;
  const changed = previousPath !== station.path;
  S.station = station;

  if (changed) {
    if (S.role === 'host') {
      if (previousPath) S.stationChangedAt = now();
      queueHostState(60);
    } else if (S.role === 'listener' && S.remote && S.remote.s !== station.path) {
      // The listener picked another station; snap back to the host's station.
      if (!isApplying()) {
        toast('The host chooses the station');
        maybeNavigate(S.remote.s);
      }
    }
  }

  updatePill();
}

/* -------------------------------------------------------------------- UI -- */

function ensureUI() {
  if (S.ui) return;
  const root = document.createElement('div');
  root.className = 'la-root la-site-rg';
  root.innerHTML = `
    <div class="la-toast" role="status"></div>
    <button class="la-sync" type="button" hidden>Tap to start the radio</button>
    <div class="la-pill">
      <span class="la-dot" aria-hidden="true"></span>
      <span class="la-label">Listen Along</span>
      <button class="la-leave" type="button" title="Leave the room">Leave</button>
    </div>
  `;
  document.documentElement.appendChild(root);

  const ui = {
    root,
    toastEl: root.querySelector('.la-toast'),
    syncBtn: root.querySelector('.la-sync'),
    label: root.querySelector('.la-label'),
    pill: root.querySelector('.la-pill'),
    leaveBtn: root.querySelector('.la-leave'),
  };

  ui.leaveBtn.addEventListener('click', () => {
    post({type: 'stop'});
  });

  ui.syncBtn.addEventListener('click', () => {
    ui.syncBtn.hidden = true;
    S.blockedUntil = 0;
    S.lastPressAt = 0;
    markApplying(2500);
    // The click is a real user gesture, so driving the site's own button here
    // lets its play() call through the autoplay policy.
    const button = playBarButton('play');
    if (button) button.click();
    else sendCommand('play');
  });

  S.ui = ui;
  renderUI();
}

function renderUI() {
  updatePill();
}

function updatePill() {
  const ui = S.ui;
  if (!ui) return;

  let text = '';
  let tone = 'idle';

  if (S.conflict) {
    text =
      S.role === 'host'
        ? 'Both of you are hosts — one should rejoin as a listener'
        : 'Both of you are listeners — one should rejoin as a host';
    tone = 'error';
  } else if (S.role === 'host') {
    if (S.status === 'connecting') {
      text = 'Hosting · connecting…';
      tone = 'wait';
    } else if (!currentStation()) {
      text = 'Hosting · open a station';
      tone = 'wait';
    } else if (S.peers > 0) {
      text = `Hosting · ${S.peers === 1 ? '1 listener' : `${S.peers} listeners`}`;
      tone = 'live';
    } else {
      text = 'Hosting · waiting for listener';
      tone = 'wait';
    }
  } else if (S.role === 'listener') {
    if (S.status === 'connecting') {
      text = 'Listening · connecting…';
      tone = 'wait';
    } else if (S.otherSite) {
      text = 'Host is listening on YouTube';
      tone = 'wait';
    } else if (S.away) {
      text = 'Host left the radio';
      tone = 'wait';
    } else if (S.peers > 0 && S.remote) {
      text = S.remote.paused ? 'Listening · host paused' : 'Listening · in sync';
      tone = 'live';
    } else if (S.peers > 0) {
      text = 'Listening · syncing…';
      tone = 'wait';
    } else {
      text = 'Listening · waiting for host';
      tone = 'wait';
    }
  } else {
    ui.root.remove();
    S.ui = null;
    return;
  }

  if (S.status === 'error' && S.message) {
    text = S.message;
    tone = 'error';
  }

  // While a play attempt is in flight the button would just flicker, so wait a
  // moment after the last attempt; any autoplay block parks attempts for 6s and
  // keeps the button visible.
  const offerTap =
    S.role === 'listener' &&
    Boolean(S.remote) &&
    !S.remote.paused &&
    (!S.media || S.media.paused) &&
    Date.now() - S.lastPressAt > 700;
  if (offerTap) showTapToSync();
  else hideTapToSync();

  ui.label.textContent = text;
  ui.pill.dataset.tone = tone;
}

function toast(message) {
  if (!S.ui) return;
  if (Date.now() - S.lastToastAt < 2500) return;
  S.lastToastAt = Date.now();
  const el = S.ui.toastEl;
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2600);
}

function showTapToSync() {
  if (S.ui) S.ui.syncBtn.hidden = false;
}

function hideTapToSync() {
  if (S.ui) S.ui.syncBtn.hidden = true;
}

/* ---------------------------------------------------------------- lifecycle -- */

// State relayed by rg-bridge.js.
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== TAG) return;

  if (data.kind === 'media') {
    onMedia({
      paused: Boolean(data.paused),
      volume: Number(data.volume) || 0,
      src: String(data.src || ''),
      readyState: Number(data.readyState) || 0,
    });
  } else if (data.kind === 'station') {
    onStation({
      path: String(data.path || ''),
      id: String(data.id || ''),
      title: String(data.title || ''),
    });
  } else if (data.kind === 'blocked') {
    S.blockedUntil = Date.now() + 6000;
    updatePill();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'page') return;

  if (msg.type === 'session') {
    applySession(msg.state);
  } else if (msg.type === 'peer') {
    onPeerMessage(msg.data);
  } else if (msg.type === 'peer-joined') {
    if (S.role === 'host') sendFullState();
    else if (S.role === 'listener') {
      S.requestAt = 0;
      requestState();
    }
  } else if (msg.type === 'peer-left') {
    updatePill();
  }
});

function tick() {
  if (S.role !== 'listener' || !S.remote || S.conflict || S.away || S.otherSite) return;

  const path = currentStation();
  if (S.remote.s && S.remote.s !== path) {
    maybeNavigate(S.remote.s);
    return;
  }

  if (S.remote.paused) {
    if (S.media && !S.media.paused && !isApplying()) pressPause();
  } else if ((!S.media || S.media.paused) && !isApplying()) {
    pressPlay();
  }
}

setInterval(tick, 700);

// Autoplay needs a real gesture. Any click on the page counts, so start the
// host's station on the first one instead of making the user hunt for a button.
document.addEventListener(
  'pointerdown',
  (event) => {
    // Leave the site's own controls alone: a real click there already toggles
    // playback, and pressing first would make that click undo it.
    if (event.target?.closest?.('.la-root, [data-jest-id="playBar"], a[data-jest-href^="/listen/"]')) {
      return;
    }
    if (S.role !== 'listener' || !S.remote || S.remote.paused || S.conflict) return;
    if (S.media && !S.media.paused) return;
    S.blockedUntil = 0;
    S.lastPressAt = 0;
    markApplying(3000);
    pressPlay(true);
  },
  true,
);

// Radio Garden can swap stations in-place. When that happens through the URL,
// follow it immediately; the channel metadata only fills in the title later.
let lastPath = location.pathname;
setInterval(() => {
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;
  if (!LISTEN_PATH.test(lastPath)) return;
  if (S.station?.path === lastPath) return;
  S.station = {path: lastPath, id: '', title: stationTitle()};
  if (S.role === 'host') {
    S.stationChangedAt = now();
    queueHostState(60);
  }
  updatePill();
}, 1000);

setInterval(() => {
  if (S.role === 'host' && !S.conflict && S.peers > 0) sendFullState();
}, 2000);

post({type: 'hello'})
  .then((response) => {
    if (response?.ok) applySession(response.state);
  })
  .catch(() => {});
