'use strict';

// The service worker is a dumb router: the popup and the YouTube content script
// never talk to each other directly, and the actual WebRTC connection lives in
// an offscreen document (service workers in MV3 cannot use RTCPeerConnection).

const APP_ID = 'listen-along-yt-v1-7d41c9';
const OFFSCREEN_URL = 'offscreen.html';
const YOUTUBE_URLS = ['https://www.youtube.com/*'];
const WATCHDOG_ALARM = 'listen-along-watchdog';

const EMPTY_STATE = {
  session: null, // {role: 'host' | 'listener', room: 'abc123'}
  status: 'idle', // idle | connecting | waiting | connected | error
  peers: 0,
  peerRoles: [],
  conflict: false,
  message: '',
};

let creatingOffscreen = null;
let stopping = false;

/* ------------------------------------------------------------------ state -- */

async function getState() {
  const stored = await chrome.storage.session.get('state');
  return {...EMPTY_STATE, ...(stored.state || {})};
}

async function setState(patch) {
  const next = {...(await getState()), ...patch};
  await chrome.storage.session.set({state: next});
  notifyPopups(next);
  return next;
}

function notifyPopups(state) {
  chrome.runtime.sendMessage({target: 'popup', type: 'state', state}).catch(() => {});
}

async function notifyTabs(payload) {
  try {
    const tabs = await chrome.tabs.query({url: YOUTUBE_URLS});
    await Promise.all(
      tabs.map((tab) =>
        chrome.tabs.sendMessage(tab.id, {target: 'yt', ...payload}).catch(() => {}),
      ),
    );
  } catch {
    /* no tabs, or the browser is shutting down */
  }
}

/* -------------------------------------------------------------- offscreen -- */

async function hasOffscreen() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WEB_RTC', 'AUDIO_PLAYBACK'],
        justification:
          'Holds the peer-to-peer WebRTC connection used to sync YouTube playback.',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

async function sendToOffscreen(message, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await chrome.runtime.sendMessage({target: 'offscreen', ...message});
      return true;
    } catch {
      // The offscreen document may still be loading.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  console.warn('[listen-along] offscreen document is not responding');
  return false;
}

/* ---------------------------------------------------------------- session -- */

function normalizeRoom(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12);
}

async function startSession({role, room}) {
  stopping = false;
  const cleanRoom = normalizeRoom(room);
  if (role !== 'host' && role !== 'listener') throw new Error('Invalid role');
  if (cleanRoom.length < 4) throw new Error('Invalid room code');

  await chrome.storage.session.set({
    state: {
      ...EMPTY_STATE,
      session: {role, room: cleanRoom},
      status: 'connecting',
    },
  });

  await ensureOffscreen();
  await chrome.alarms.create(WATCHDOG_ALARM, {periodInMinutes: 0.5});

  const ok = await sendToOffscreen({type: 'join', role, room: cleanRoom});
  if (!ok) {
    await setState({
      status: 'error',
      message: 'Could not start the sync engine. Try reloading the extension.',
    });
  }

  const state = await getState();
  notifyTabs({type: 'session', state});
  notifyPopups(state);
  return state;
}

async function stopSession(reason = '') {
  stopping = true;
  // Clear the stored session first so a racing alarm cannot revive it.
  await chrome.storage.session.set({state: EMPTY_STATE});
  await chrome.alarms.clear(WATCHDOG_ALARM);
  await sendToOffscreen({type: 'leave'}, 3);
  await closeOffscreen();
  notifyTabs({type: 'session', state: EMPTY_STATE, message: reason});
  notifyPopups(EMPTY_STATE);
  stopping = false;
  return EMPTY_STATE;
}

// If the offscreen document was torn down (browser restart, crash, Chrome
// reclaiming it) recreate it and rejoin the room.
async function reviveSession() {
  if (stopping) return getState();
  const state = await getState();
  if (!state.session) return state;
  if (await hasOffscreen()) return state;
  await ensureOffscreen();
  await sendToOffscreen({type: 'join', ...state.session}, 30);
  return getState();
}

/* --------------------------------------------------------------- messages -- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  // ---- from the popup ------------------------------------------------------
  if (msg.target === 'bg') {
    if (msg.type === 'get-state') {
      reviveSession()
        .then((state) => sendResponse({ok: true, state}))
        .catch((err) => sendResponse({ok: false, error: String(err)}));
      return true;
    }

    if (msg.type === 'start') {
      startSession(msg)
        .then((state) => sendResponse({ok: true, state}))
        .catch((err) => sendResponse({ok: false, error: String(err?.message || err)}));
      return true;
    }

    if (msg.type === 'stop') {
      stopSession()
        .then((state) => sendResponse({ok: true, state}))
        .catch((err) => sendResponse({ok: false, error: String(err)}));
      return true;
    }

    // ---- from the offscreen peer connection --------------------------------
    if (msg.type === 'offscreen-status') {
      (async () => {
        const state = await setState({
          status: msg.status,
          peers: msg.peers || 0,
          peerRoles: msg.peerRoles || [],
          conflict: Boolean(msg.conflict),
          message: msg.message || '',
        });
        notifyTabs({type: 'session', state});
        sendResponse({ok: true});
      })();
      return true;
    }

    if (msg.type === 'peer-message') {
      notifyTabs({type: 'peer', data: msg.data});
      sendResponse({ok: true});
      return false;
    }

    if (msg.type === 'peer-joined' || msg.type === 'peer-left') {
      notifyTabs({type: msg.type});
      sendResponse({ok: true});
      return false;
    }

    // ---- from the YouTube content script -----------------------------------
    if (msg.type === 'hello') {
      reviveSession()
        .then((state) => {
          notifyTabs({type: 'session', state});
          sendResponse({ok: true, state});
        })
        .catch(() => sendResponse({ok: false}));
      return true;
    }

    if (msg.type === 'broadcast') {
      sendToOffscreen({type: 'broadcast', data: msg.data}, 3)
        .then((ok) => sendResponse({ok}))
        .catch(() => sendResponse({ok: false}));
      return true;
    }

    if (msg.type === 'request-revive') {
      reviveSession()
        .then((state) => {
          notifyTabs({type: 'session', state});
          sendResponse({ok: true, state});
        })
        .catch(() => sendResponse({ok: false}));
      return true;
    }
  }

  return false;
});

/* ---------------------------------------------------------------- alarms -- */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  reviveSession().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  // Offscreen documents do not survive a browser restart; make the user rejoin
  // instead of silently pretending the room is still live.
  chrome.storage.session.set({state: EMPTY_STATE});
  chrome.alarms.clear(WATCHDOG_ALARM);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.clear(WATCHDOG_ALARM);
});
