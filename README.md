# Listen Along — YouTube & Radio Garden

A Chrome extension that keeps two people on the same YouTube video — or tuned to
the same live Radio Garden station — with one person in control. No accounts, no
sign-in, no server of your own: the two browsers find each other through public
relays and then talk directly over an encrypted WebRTC data channel.

```
Host browser  ──┐                        ┌── Listener browser
                │   public relay (Nostr) │
                │   used only for the    │
                │   initial handshake    │
                └────────┬───────────────┘
                         │
                direct WebRTC data channel
                (play / pause / seek / rate / video id / station)
```

Playback state never passes through a third party. The relay only exchanges the
WebRTC session descriptions needed to open the peer-to-peer channel.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension if you want quick access.

Chrome 116 or newer is required (offscreen documents + `chrome.runtime.getContexts`).

## Use

1. The host opens a YouTube video or tunes a Radio Garden station, clicks the
   extension icon, then **Host**. A six-character room code appears.
2. The listener clicks the extension icon, then **Listen**, and enters that code.
3. When the pill says **in sync**, the host's play, pause, seek, speed, video and
   station changes are mirrored automatically. The pill sits in the bottom-left
   on YouTube and the top-left on Radio Garden.

The listener cannot fight the host's playback: pausing, seeking, changing the
speed or picking another radio station is reverted (with a small toast), and
playing a different video snaps back to the host's video.

Notes:

- Both people should use the same site: YouTube for video sync, Radio Garden for
  radio. A listener on the other site sees **Host is listening on …** instead of
  trying to sync. The listener's tab can be in the background.
- Keep the extension's connection alive by leaving Chrome running; the popup
  shows the live status.
- If the listener's browser blocks autoplay, a **Tap to resume playback** button
  (YouTube) or **Tap to start the radio** button (Radio Garden) appears on the
  page. Clicking anywhere on the page also starts playback.
- The room code is the only secret. Anyone with the code and the extension can
  join, so share it privately.

## How it works

| Piece | Responsibility |
| --- | --- |
| `popup.html/js/css` | Create/join a room, show connection state, copy the invite. |
| `background.js` | Service worker. Routes messages between the popup, content scripts and the offscreen document. Keeps a watchdog alarm alive. |
| `offscreen.html/js` | Owns the WebRTC connection. MV3 service workers cannot use `RTCPeerConnection`, so the peer lives in an offscreen document (reasons: `WEB_RTC`, `AUDIO_PLAYBACK`). |
| `content.js/css` | Runs on `youtube.com`. Reads the host's `<video>` element, applies the listener's state, corrects drift, enforces host control, renders the status pill. |
| `content-radio.js/css` | Runs on `radio.garden`. Mirrors the tuned station and play/pause, snaps the listener back to the host's station, renders the same status pill. |
| `rg-bridge.js` | Runs in the page's own world on `radio.garden` (`"world": "MAIN"`). Radio Garden plays through a detached `new Audio()`, invisible to content scripts, so this bridge captures that element and relays its state over `postMessage`. |
| `vendor/trystero.bundle.js` | Bundled [Trystero](https://github.com/dmotz/trystero) (Nostr strategy) for serverless peer discovery. |

Sync details:

- The host sends a full state snapshot on play/pause/seek/rate changes and every
  2 seconds as a heartbeat.
- The listener stores the host's position with a local monotonic timestamp, so
  clock skew between machines does not matter.
- Corrections: below 0.15 s drift nothing happens; up to 1.2 s the playback rate
  is nudged ±5% to catch up; beyond that it seeks.
- Video changes are broadcast as a YouTube video id; the listener navigates to
  it. When the host leaves the watch page, listeners are released from control.
- Radio Garden is live, so its state is the tuned station plus play/pause — there
  is no position to exchange. The station path (`/listen/<slug>/<id>`) is read
  from the channel metadata the site requests when it tunes, which also covers
  playback started from the globe without a URL change. A station change sends
  the listener to that page; a pause resumes at the live edge.

## Develop

```sh
npm install         # trystero + esbuild
npm run build       # rebuild vendor/trystero.bundle.js
npm run icons       # regenerate icons/ and keepalive.wav (Python + Pillow)
npm run check       # syntax-check the extension scripts
npm run pack        # build dist/listen-along-v<version>.zip for sharing
```

The extension itself has no build step for day-to-day edits: reload it from
`chrome://extensions` after changing a file.

### Sharing it

`npm run pack` writes a zip containing only the runtime files plus `INSTALL.txt`.
The recipient unzips it, turns on **Developer mode** in `chrome://extensions`,
and clicks **Load unpacked** on the unzipped `listen-along` folder. The folder
must stay where it is, because Chrome loads the extension from it on every start.

Unpacked installs get a different extension ID on every machine, but room codes
still interoperate: peers agree on the fixed `APP_ID` in `offscreen.js`, not on
the extension ID.

### Project files

`node_modules/`, `src/` and `scripts/` are development-only. Loading the folder
unpacked ignores them.

## Limitations

- Public Nostr relays are used for discovery. They are generally reliable but
  can be slow or blocked on restrictive networks.
- Direct connections rely on STUN. Two users behind symmetric NATs or strict
  corporate firewalls may need a TURN server; add one under `rtcConfig.iceServers`
  in `offscreen.js` if that comes up.
- Only regular `youtube.com/watch` videos are synced (not Shorts, live streams
  or YouTube Music).
- The listener follows the host's video. Browsing away from `/watch` is allowed;
  visiting another video snaps back.
- Radio Garden stations are live streams: they cannot be seeked, and resuming
  after a pause joins the broadcast at the live edge.
- On Radio Garden, station changes go through the page's own list when the
  station is listed, which keeps playback running. Otherwise the listener's tab
  reloads to the station and browsers may require one click before audio starts.

## Troubleshooting

- **Stuck on “Connecting…”** — relays may be unreachable. Try another network
  or reload the extension.
- **“Role conflict”** — both people chose the same role. One should leave and
  rejoin with the other role.
- **Connected but not syncing** — make sure both tabs are on the same site
  (`youtube.com/watch`, or any `radio.garden` page with a station playing) and
  that the host has pressed play at least once.
- **Audio blocked on the listener** — click **Tap to resume playback** on the
  page, or **Tap to start the radio** on Radio Garden.

## Testing with Chrome DevTools MCP

`opencode.json` configures [Chrome DevTools for agents](https://developer.chrome.com/docs/extensions/ai/build-with-ai)
with `--categoryExtensions --autoConnect`. The server runs through Windows
`cmd.exe` so it can attach to the Windows Chrome instance, while OpenCode itself
runs in WSL.

One-time per browser session: open `chrome://inspect/#remote-debugging`, enable
**Allow remote debugging for this browser instance**, and approve Chrome's
dialog. Then the MCP can install/reload the extension and inspect its popup,
service worker and target pages.
