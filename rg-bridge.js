'use strict';

// MAIN-world bridge for radio.garden.
//
// Radio Garden keeps its player in a detached `new Audio()` object, so the
// isolated content script can never reach it through the DOM. This script runs
// in the page's own world, captures that element and relays playback state to
// content-radio.js over postMessage. The content script sends commands back the
// same way. It deliberately does nothing unless a session is active on the page.

(() => {
  const TAG = 'listen-along-rg';
  const CHANNEL_API = '/api/ara/content/channel/';

  if (window.__listenAlongRadioGarden) return;
  window.__listenAlongRadioGarden = true;

  const origin = location.origin;
  const MEDIA_EVENTS = [
    'play',
    'playing',
    'pause',
    'waiting',
    'stalled',
    'ended',
    'error',
    'volumechange',
    'emptied',
    'loadedmetadata',
  ];

  let media = null;
  let lastStation = null;

  function post(message) {
    try {
      window.postMessage({source: TAG, ...message}, origin);
    } catch {
      /* the page may be unloading */
    }
  }

  function report() {
    if (!media) return;
    post({
      kind: 'media',
      paused: Boolean(media.paused),
      volume: Number(media.volume),
      muted: Boolean(media.muted),
      readyState: Number(media.readyState),
      src: String(media.currentSrc || media.src || ''),
    });
  }

  function onMediaEvent(event) {
    if (event.target !== media) return;
    report();
  }

  function bind(element) {
    if (!element || element === media) return;
    if (media) {
      for (const name of MEDIA_EVENTS) media.removeEventListener(name, onMediaEvent);
    }
    media = element;
    for (const name of MEDIA_EVENTS) media.addEventListener(name, onMediaEvent);
    report();
  }

  // The player is created with `new Audio`, and may be replaced when a new
  // station starts. Capturing the first element that actually plays covers
  // both the HLS player and any direct stream playback.
  const proto = HTMLMediaElement.prototype;
  const originalPlay = proto.play;
  proto.play = function patchedPlay(...args) {
    bind(this);
    let result;
    try {
      result = originalPlay.apply(this, args);
    } catch (error) {
      if (error && error.name === 'NotAllowedError') {
        post({kind: 'blocked', reason: 'autoplay'});
      }
      throw error;
    }
    if (result && typeof result.catch === 'function') {
      result.catch((error) => {
        if (error && error.name === 'NotAllowedError') {
          post({kind: 'blocked', reason: 'autoplay'});
        }
      });
    }
    return result;
  };

  function postStation() {
    if (!lastStation) return;
    post({kind: 'station', ...lastStation});
  }

  function publishStation(data) {
    if (!data || typeof data !== 'object') return;
    const path = typeof data.url === 'string' ? data.url : '';
    if (!/^\/listen\//.test(path)) return;
    lastStation = {
      path,
      id: typeof data.id === 'string' ? data.id : '',
      title: typeof data.title === 'string' ? data.title : '',
      place: data.place && typeof data.place.title === 'string' ? data.place.title : '',
    };
    postStation();
  }

  // The station currently playing is not always reflected in the URL (the globe
  // plays without navigating), so observe the channel metadata the site fetches
  // whenever it tunes. That payload is the canonical `/listen/<slug>/<id>`.
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function patchedFetch(input, init) {
      const url =
        typeof input === 'string'
          ? input
          : input && typeof input.url === 'string'
            ? input.url
            : '';
      const response = originalFetch.apply(this, arguments);
      if (url.indexOf(CHANNEL_API) !== -1) {
        response
          .then((result) => result.clone().json())
          .then((payload) => publishStation(payload && payload.data))
          .catch(() => {});
      }
      return response;
    };
  }

  // Older builds use XHR for the same request.
  if (typeof window.XMLHttpRequest === 'function') {
    const xhrProto = window.XMLHttpRequest.prototype;
    const originalOpen = xhrProto.open;
    const originalSend = xhrProto.send;

    xhrProto.open = function patchedOpen(method, url, ...rest) {
      this.__listenAlongUrl = typeof url === 'string' ? url : '';
      return originalOpen.call(this, method, url, ...rest);
    };

    xhrProto.send = function patchedSend(...args) {
      if (this.__listenAlongUrl && this.__listenAlongUrl.indexOf(CHANNEL_API) !== -1) {
        this.addEventListener('load', () => {
          try {
            publishStation(JSON.parse(this.responseText).data);
          } catch {
            /* not JSON, ignore */
          }
        });
      }
      return originalSend.apply(this, args);
    };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== TAG || data.kind !== 'cmd') return;

    if (!media) {
      post({kind: 'unavailable'});
      return;
    }

    if (data.cmd === 'play') {
      const result = media.play();
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          if (error && error.name === 'NotAllowedError') {
            post({kind: 'blocked', reason: 'autoplay'});
          }
        });
      }
    } else if (data.cmd === 'pause') {
      media.pause();
    } else if (data.cmd === 'status') {
      report();
      postStation();
    }
  });

  // Covers state changes that do not fire a media event (stream stalls, the
  // site swapping players) and keeps the content script's view fresh.
  setInterval(report, 1000);
})();
