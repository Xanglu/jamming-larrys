'use strict';

// This document owns the WebRTC connection. MV3 service workers cannot create
// RTCPeerConnection objects, so all peer traffic lives here and is relayed to
// the content script through the service worker.

const APP_ID = 'listen-along-yt-v1-7d41c9';

const lib = globalThis.TrysteroLib;
let room = null;
let action = null;
let localRole = null;
let peerRoles = new Map();
let greeted = new Set();
let status = 'idle';
let message = '';
let lastError = '';

const keepAlive = document.getElementById('keepalive');

/* --------------------------------------------------------------- plumbing -- */

function post(msg) {
  chrome.runtime.sendMessage({target: 'bg', ...msg}).catch(() => {});
}

function peerRoleList() {
  return [...peerRoles.values()].filter(Boolean);
}

function hasConflict() {
  return localRole ? peerRoleList().some((role) => role === localRole) : false;
}

function emitStatus(nextStatus = status, nextMessage = message) {
  status = nextStatus;
  message = nextMessage;
  post({
    type: 'offscreen-status',
    status,
    message,
    peers: room ? Object.keys(room.getPeers()).length : 0,
    peerRoles: peerRoleList(),
    conflict: hasConflict(),
  });
}

function resetRoomState() {
  peerRoles = new Map();
  greeted = new Set();
  lastError = '';
}

/* ------------------------------------------------------------------ joining -- */

async function leave({silent = false} = {}) {
  const oldRoom = room;
  room = null;
  action = null;
  if (oldRoom) {
    try {
      await oldRoom.leave();
    } catch {
      /* already gone */
    }
  }
  resetRoomState();
  if (!silent) emitStatus('idle', '');
}

async function join({role, room: roomId}) {
  await leave({silent: true});

  localRole = role;
  emitStatus('connecting', 'Reaching the relay network…');

  if (!lib) {
    emitStatus('error', 'The sync engine failed to load.');
    return;
  }

  try {
    room = lib.joinRoom(
      {
        appId: APP_ID,
        relayConfig: {redundancy: 4, warnOnRelayFailure: false},
        // Public STUN is enough for most home networks. Add TURN servers here
        // if your users are behind symmetric NATs / strict corporate firewalls.
        rtcConfig: {iceServers: [{urls: ['stun:stun.l.google.com:19302']}]},
      },
      roomId,
      {
        onJoinError: ({peerId, error}) => {
          lastError = String(error?.message || error);
          console.warn('[listen-along] peer join error', peerId, lastError);
          emitStatus(
            'error',
            'Direct connection failed. One of you may be on a restrictive network.',
          );
        },
      },
    );
  } catch (err) {
    emitStatus('error', `Could not join room: ${err?.message || err}`);
    return;
  }

  action = room.makeAction('sync', {
    onMessage: (data, context) => {
      if (!data || typeof data !== 'object') return;
      if (data.t === 'hello') {
        peerRoles.set(context.peerId, data.role);
        if (!greeted.has(context.peerId)) {
          greeted.add(context.peerId);
          // Answer once so both sides learn each other's role.
          action.send({t: 'hello', role: localRole}, {target: context.peerId}).catch(() => {});
        }
        emitStatus();
        return;
      }
      post({type: 'peer-message', data, peerId: context.peerId});
    },
  });

  room.onPeerJoin = (peerId) => {
    greeted.delete(peerId);
    // Announce our role; the peer answers with theirs.
    action.send({t: 'hello', role: localRole}, {target: peerId}).catch(() => {});
    emitStatus('connected');
    post({type: 'peer-joined', peerId});
  };

  room.onPeerLeave = (peerId) => {
    peerRoles.delete(peerId);
    greeted.delete(peerId);
    const remaining = Object.keys(room.getPeers()).length;
    emitStatus(remaining ? 'connected' : 'waiting');
    post({type: 'peer-left', peerId});
  };

  emitStatus('waiting', 'Room open. Waiting for the other person…');

  // Re-announce periodically in case the very first hello raced a channel that
  // was not fully open yet.
  setTimeout(() => {
    if (!room) return;
    action.send({t: 'hello', role: localRole}).catch(() => {});
  }, 3000);
}

/* ---------------------------------------------------------------- messages -- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  if (msg.type === 'join') {
    join(msg)
      .then(() => sendResponse({ok: true}))
      .catch((err) => sendResponse({ok: false, error: String(err)}));
    return true;
  }

  if (msg.type === 'leave') {
    leave()
      .then(() => sendResponse({ok: true}))
      .catch(() => sendResponse({ok: true}));
    return true;
  }

  if (msg.type === 'broadcast') {
    if (!action) {
      sendResponse({ok: false});
      return false;
    }
    action
      .send(msg.data)
      .then(() => sendResponse({ok: true}))
      .catch((err) => {
        console.warn('[listen-along] send failed', err);
        sendResponse({ok: false});
      });
    return true;
  }

  return false;
});

/* ------------------------------------------------------------- keep alive -- */

// Chrome tears offscreen documents down after ~30s of inactivity unless they
// are playing audio. A silent 1s loop keeps the WebRTC connection open for the
// whole listening session, and the periodic ping keeps the service worker from
// dropping its routing state.
if (keepAlive) {
  const tryPlay = () => keepAlive.play().catch(() => setTimeout(tryPlay, 1000));
  tryPlay();
}

setInterval(() => post({type: 'offscreen-ping'}), 20_000);
