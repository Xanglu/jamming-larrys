'use strict';

// Runs on every youtube.com page (top frame). The host's copy of this script
// reports playback changes and the listener's copy mirrors them. All traffic
// goes content script -> service worker -> offscreen WebRTC peer.

const S = {
  role: null, // 'host' | 'listener'
  room: null,
  status: 'idle', // idle | connecting | waiting | connected | error
  peers: 0,
  conflict: false,
  message: '',
  remote: null, // {v, time, playedAt, paused, rate}
  away: false, // host left the watch page
  video: null,
  applyingUntil: 0,
  navigatingUntil: 0,
  nudging: false,
  lastHref: location.href,
  lastToastAt: 0,
  toastTimer: 0,
  hostSendTimer: 0,
  requestAt: 0,
  ui: null,
};

const now = () => performance.now();
const currentVideoId = () => {
  try {
    return new URL(location.href).searchParams.get('v');
  } catch {
    return null;
  }
};
const isWatch = () => location.pathname === '/watch' && Boolean(currentVideoId());
const HOST_EVENTS = ['play', 'pause', 'seeked', 'ratechange', 'ended'];
const markApplying = (ms = 1200) => {
  S.applyingUntil = Date.now() + ms;
};
const isApplying = () => Date.now() < S.applyingUntil;
const remoteTarget = () => {
  const r = S.remote;
  if (!r) return NaN;
  if (r.paused) return r.time;
  const rate = Number.isFinite(r.rate) && r.rate > 0 ? r.rate : 1;
  return r.time + ((now() - r.playedAt) / 1000) * rate;
};

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
  if (S.role !== 'host' || S.conflict || !S.video || !isWatch()) return;
  send({
    t: 'state',
    site: 'yt',
    v: currentVideoId(),
    time: S.video.currentTime,
    paused: S.video.paused,
    rate: S.video.playbackRate,
  });
}

/* ---------------------------------------------------------------- session -- */

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
    restoreRate();
  }

  ensureUI();
  renderUI();

  if (previousRole !== S.role) {
    S.remote = null;
    S.away = false;
    restoreRate();
    if (S.role === 'listener') requestState();
  }

  if (S.peers > 0 && previousPeers === 0) {
    if (S.role === 'host') sendFullState();
    else requestState();
  }

  if (S.role === 'listener' && S.remote?.v && isWatch() && S.remote.v !== currentVideoId()) {
    maybeNavigate(S.remote.v);
  }
}

function teardown() {
  S.remote = null;
  S.away = false;
  S.conflict = false;
  restoreRate();
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
      renderUI();
    }
    return;
  }

  if (data.t !== 'state' || S.role !== 'listener' || S.conflict) return;

  // A Radio Garden host has nothing in common with a YouTube listener.
  if (data.site && data.site !== 'yt') {
    S.remote = null;
    S.away = true;
    renderUI();
    return;
  }

  const state = {
    v: typeof data.v === 'string' ? data.v : null,
    time: Number(data.time) || 0,
    paused: Boolean(data.paused),
    rate: Number(data.rate) > 0 ? Number(data.rate) : 1,
    playedAt: now(),
  };
  S.remote = state;
  S.away = false;

  if (state.v && state.v !== currentVideoId()) {
    maybeNavigate(state.v);
    renderUI();
    return;
  }

  applyRemote(true);
  renderUI();
}

function maybeNavigate(videoId) {
  if (S.role !== 'listener' || !videoId) return;
  if (Date.now() < S.navigatingUntil) return;
  if (currentVideoId() === videoId) return;

  S.navigatingUntil = Date.now() + 10_000;
  let url;
  try {
    url = new URL(location.href);
  } catch {
    return;
  }
  url.pathname = '/watch';
  url.searchParams.set('v', videoId);
  location.assign(url.toString());
}

function safePlay() {
  const video = S.video;
  if (!video) return;
  const result = video.play();
  if (result && typeof result.then === 'function') {
    result.then(hideTapToSync, (error) => {
      // Only a real autoplay block needs a click from the user. Interrupted
      // play() calls (navigation, ads, seeks, rapid pause/play) reject with
      // AbortError and are routine, not something to prompt about.
      if (error?.name === 'NotAllowedError') showTapToSync();
    });
  }
}

function applyRemote(hard = false) {
  const video = S.video;
  const remote = S.remote;
  if (!video || !remote) return;
  if (remote.v && remote.v !== currentVideoId()) {
    maybeNavigate(remote.v);
    return;
  }

  const target = remoteTarget();
  if (!Number.isFinite(target)) return;
  const drift = video.currentTime - target;

  // Only arm the "this event is ours" guard when we actually change something,
  // otherwise every heartbeat would swallow the user's own play/pause events.
  let touched = false;
  const touch = () => {
    if (touched) return;
    touched = true;
    markApplying(hard ? 1000 : 1500);
  };

  if (Math.abs(drift) > (hard ? 0.35 : 1.0)) {
    touch();
    try {
      video.currentTime = Math.max(0, target);
    } catch {
      /* not seekable yet */
    }
  }

  if (remote.paused) {
    if (!video.paused) {
      touch();
      video.pause();
    }
  } else if (video.paused) {
    touch();
    safePlay();
  }

  if (!S.nudging && Math.abs(video.playbackRate - remote.rate) > 0.001) {
    touch();
    video.playbackRate = remote.rate;
  }
}

function restoreRate() {
  if (!S.video || !S.remote) return;
  if (S.nudging || Math.abs(S.video.playbackRate - S.remote.rate) > 0.001) {
    S.nudging = false;
    try {
      S.video.playbackRate = S.remote.rate;
    } catch {
      /* ignore */
    }
  }
}

function nudge(direction) {
  const video = S.video;
  const remote = S.remote;
  if (!video || !remote) return;
  const target = remote.rate * (direction > 0 ? 1.05 : 0.95);
  S.nudging = true;
  markApplying(400);
  if (Math.abs(video.playbackRate - target) > 0.005) {
    try {
      video.playbackRate = target;
    } catch {
      /* ignore */
    }
  }
}

/* -------------------------------------------------------------- listeners -- */

function onVideoPlay() {
  hideTapToSync();
  if (S.role !== 'listener' || !S.remote || S.away || isApplying()) return;
  if (S.remote.paused) {
    markApplying(600);
    S.video.pause();
    toast('The host has playback paused');
  }
}

function onVideoPause() {
  if (S.role !== 'listener' || !S.remote || S.away || isApplying()) return;
  if (S.video?.ended) return;
  if (!S.remote.paused) {
    markApplying(600);
    safePlay();
    toast('The host controls playback');
  }
}

function onVideoSeeked() {
  if (S.role !== 'listener' || !S.remote || S.away || isApplying()) return;
  const target = remoteTarget();
  if (!Number.isFinite(target)) return;
  if (Math.abs(S.video.currentTime - target) > 0.6) {
    markApplying(800);
    try {
      S.video.currentTime = Math.max(0, target);
    } catch {
      /* not seekable yet */
    }
    toast('Following the host’s playhead');
  }
}

function onRateChange() {
  if (S.role !== 'listener' || !S.remote || S.away || isApplying()) return;
  if (Math.abs(S.video.playbackRate - S.remote.rate) > 0.02) {
    markApplying(400);
    S.video.playbackRate = S.remote.rate;
  }
}

// Host side: push play/pause/seek/rate changes right away instead of waiting
// for the next heartbeat.
function onHostPlaybackEvent() {
  if (S.role !== 'host' || S.conflict) return;
  clearTimeout(S.hostSendTimer);
  S.hostSendTimer = setTimeout(sendFullState, 60);
}

/* ------------------------------------------------------------ video binding -- */

function findVideo() {
  const main = document.querySelector('video.html5-main-video');
  if (main) return main;
  const candidates = [...document.querySelectorAll('video')].filter(
    (v) => v.currentSrc || v.readyState > 0,
  );
  return candidates[0] || null;
}

function detachVideo() {
  const video = S.video;
  if (!video) return;
  video.removeEventListener('play', onVideoPlay);
  video.removeEventListener('pause', onVideoPause);
  video.removeEventListener('seeked', onVideoSeeked);
  video.removeEventListener('ratechange', onRateChange);
  video.removeEventListener('loadedmetadata', onMetadata);
  for (const name of HOST_EVENTS) video.removeEventListener(name, onHostPlaybackEvent);
  S.video = null;
}

function attachVideo() {
  const video = findVideo();
  if (!video || video === S.video) return;

  detachVideo();
  S.video = video;
  video.addEventListener('play', onVideoPlay);
  video.addEventListener('pause', onVideoPause);
  video.addEventListener('seeked', onVideoSeeked);
  video.addEventListener('ratechange', onRateChange);
  video.addEventListener('loadedmetadata', onMetadata);
  for (const name of HOST_EVENTS) video.addEventListener(name, onHostPlaybackEvent);

  if (S.role === 'listener') {
    if (S.remote?.v && S.remote.v !== currentVideoId()) {
      maybeNavigate(S.remote.v);
    } else if (S.remote) {
      applyRemote(true);
    } else {
      requestState();
    }
  }

  updatePill();
}

function onMetadata() {
  if (S.role === 'listener' && S.remote) applyRemote(true);
}

/* ---------------------------------------------------------------- lifecycle -- */

function onNavigate() {
  if (location.href === S.lastHref) return;
  S.lastHref = location.href;
  S.nudging = false;
  attachVideo();

  if (S.role === 'host') {
    if (isWatch()) {
      // Give YouTube a moment to mount the player, then publish the new video.
      setTimeout(() => {
        if (S.role !== 'host' || S.conflict) return;
        attachVideo();
        if (S.video && isWatch()) {
          send({
            t: 'state',
            site: 'yt',
            v: currentVideoId(),
            time: S.video.currentTime,
            paused: S.video.paused,
            rate: S.video.playbackRate,
          });
        }
      }, 700);
    } else {
      send({t: 'away'});
    }
  } else if (S.role === 'listener') {
    if (S.remote?.v && isWatch() && S.remote.v !== currentVideoId()) {
      maybeNavigate(S.remote.v);
    } else if (isWatch()) {
      requestState();
    }
  }

  updatePill();
}

function tick() {
  if (S.role !== 'listener' || !S.remote || S.away || S.conflict) return;
  const video = S.video;
  if (!video || !isWatch()) return;

  if (S.remote.v && S.remote.v !== currentVideoId()) {
    maybeNavigate(S.remote.v);
    return;
  }

  const target = remoteTarget();
  if (!Number.isFinite(target)) return;

  if (S.remote.paused) {
    if (!video.paused && !isApplying()) {
      markApplying(600);
      video.pause();
    }
    if (Math.abs(video.currentTime - target) > 0.5 && !isApplying()) {
      markApplying(600);
      try {
        video.currentTime = Math.max(0, target);
      } catch {
        /* not seekable yet */
      }
    }
    restoreRate();
    return;
  }

  if (video.paused && !video.ended && !isApplying()) {
    safePlay();
  }

  const drift = video.currentTime - target;
  if (Math.abs(drift) > 1.2) {
    markApplying(600);
    try {
      video.currentTime = Math.max(0, target);
    } catch {
      /* not seekable yet */
    }
    restoreRate();
  } else if (Math.abs(drift) > 0.15) {
    nudge(drift > 0 ? -1 : 1);
  } else {
    restoreRate();
  }
}

/* --------------------------------------------------------------------- UI -- */

function ensureUI() {
  if (S.ui) return;
  const root = document.createElement('div');
  root.className = 'la-root la-site-yt';
  root.innerHTML = `
    <div class="la-toast" role="status"></div>
    <button class="la-sync" type="button" hidden>Tap to resume playback</button>
    <div class="la-pill">
      <img class="la-mascot" src="${chrome.runtime.getURL('assets/mascot.webp')}" alt="" />
      <span class="la-dot" aria-hidden="true"></span>
      <span class="la-label">Jamming Larrys</span>
      <button class="la-leave" type="button" title="Leave the room">Leave</button>
    </div>
  `;
  document.documentElement.appendChild(root);

  const ui = {
    root,
    pill: root.querySelector('.la-pill'),
    dot: root.querySelector('.la-dot'),
    label: root.querySelector('.la-label'),
    toastEl: root.querySelector('.la-toast'),
    syncBtn: root.querySelector('.la-sync'),
    leaveBtn: root.querySelector('.la-leave'),
  };

  ui.leaveBtn.addEventListener('click', () => {
    post({type: 'stop'});
  });

  ui.syncBtn.addEventListener('click', () => {
    ui.syncBtn.hidden = true;
    markApplying(1200);
    safePlay();
  });

  // Autoplay needs a real gesture; any click on the page counts. Start the
  // host's video on the first one instead of requiring the tap button.
  document.addEventListener(
    'pointerdown',
    (event) => {
      // The player and its controls toggle playback on a real click; doing the
      // same on pointerdown would make that click immediately undo it.
      if (event.target?.closest?.('.la-root, #movie_player, .html5-video-player')) return;
      if (S.role !== 'listener' || !S.remote || S.remote.paused || S.away) return;
      if (!S.video?.paused || isApplying()) return;
      markApplying(2500);
      hideTapToSync();
      safePlay();
    },
    true,
  );

  S.ui = ui;
  renderUI();
}

function renderUI() {
  if (!S.ui) return;
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
    } else if (S.away) {
      text = 'Host left the video';
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

  // The tap-to-resume affordance only makes sense while the host is playing
  // but this tab's video is still stuck paused. Hide it in every other case,
  // including right after playback recovers.
  const offerTap =
    S.role === 'listener' && Boolean(S.remote) && !S.remote.paused && Boolean(S.video?.paused);
  if (!offerTap) hideTapToSync();

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
  if (!S.ui) return;
  if (S.role !== 'listener' || !S.remote || S.remote.paused) return;
  if (!S.video?.paused) return;
  S.ui.syncBtn.hidden = false;
}

function hideTapToSync() {
  if (S.ui) S.ui.syncBtn.hidden = true;
}

/* -------------------------------------------------------------- bootstrap -- */

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

setInterval(() => {
  attachVideo();
  onNavigate();
}, 1000);

setInterval(tick, 500);

setInterval(() => {
  if (S.role === 'host' && !S.conflict && S.peers > 0) sendFullState();
}, 2000);

// YouTube is a single-page app.
for (const event of ['yt-navigate-finish', 'yt-page-data-updated']) {
  document.addEventListener(event, () => {
    setTimeout(onNavigate, 250);
  });
}
window.addEventListener('popstate', () => setTimeout(onNavigate, 250));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    attachVideo();
    tick();
  }
});

post({type: 'hello'})
  .then((response) => {
    if (response?.ok) applySession(response.state);
  })
  .catch(() => {});
