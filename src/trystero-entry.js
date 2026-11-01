// Bundled into vendor/trystero.bundle.js by `npm run build`.
// Trystero gives us serverless peer discovery over public relays, then a
// direct, encrypted WebRTC data channel between the two browsers.
import {joinRoom, selfId, getRelaySockets} from 'trystero';

globalThis.TrysteroLib = {joinRoom, selfId, getRelaySockets};
