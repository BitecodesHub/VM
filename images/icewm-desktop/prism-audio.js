/* PRISM Virtual Desktop — desktop speaker audio.
 *
 * The open-source KasmVNC web client does NOT play desktop audio itself: on
 * focus it posts {action:"enable_audio"} to its parent and relies on the paid
 * Kasm Workspaces app to open the audio stream. We are not that app, so we play
 * it here. KasmVNC's audio-out websocket (container :4901, streaming MPEG-TS/MP2)
 * is proxied by the panel at <base>/kasmaudio; jsmpeg decodes it to WebAudio.
 *
 * Cost note: decoding is entirely client-side (in the browser). The server only
 * relays bytes, and the ffmpeg encoder already runs — so this adds no meaningful
 * server load.
 */
(function () {
  'use strict';
  if (window.__prismAudioBooted) return;
  window.__prismAudioBooted = true;

  function baseDir() {
    var p = location.pathname;
    return p.slice(0, p.lastIndexOf('/') + 1); // e.g. /m/<name>/
  }
  function audioUrl() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host + baseDir() + 'kasmaudio';
  }

  var player = null;

  function start() {
    if (player || typeof window.JSMpeg === 'undefined') return;
    try {
      player = new window.JSMpeg.Player(audioUrl(), {
        audio: true,
        video: false,
        autoplay: true,
        audioBufferSize: 65536,
        // Reconnect if the socket drops (desktop stop/start, network blip).
        reconnectInterval: 3,
      });
      window.__prismAudio = player;
    } catch (e) {
      player = null;
      try { console.warn('[PRISM audio] init failed:', e); } catch (x) {}
    }
  }

  // Browser autoplay policy blocks audio until a user gesture. Open the socket
  // on load (so the stream is ready) and resume the AudioContext on the first
  // real interaction inside the desktop.
  function resume() {
    try {
      var ctx = player && player.audioOut && player.audioOut.context;
      if (ctx && ctx.state === 'suspended') ctx.resume();
    } catch (e) {}
  }

  function boot() { start(); resume(); }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 600); });
  } else {
    setTimeout(boot, 600);
  }
  ['pointerdown', 'mousedown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, boot, true);
  });
  // The KasmVNC canvas posts enable_audio on focus; honour it as a start signal.
  window.addEventListener('message', function (e) {
    if (e && e.data && e.data.action === 'enable_audio') boot();
  });
})();
