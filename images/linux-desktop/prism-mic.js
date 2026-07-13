/* PRISM Virtual Desktop — microphone (audio input).
 *
 * The OSS KasmVNC client cannot send the mic; only Kasm Workspaces can. We add
 * it: capture the browser mic, encode raw s16le PCM (mono), and stream it over a
 * WebSocket to KasmVNC's audio-input server (container :4903), which the panel
 * proxies at <base>kasmmic?sample_rate=<N>. The server then creates a
 * `virtual_mic` PulseAudio source and sets it default, so desktop apps hear it.
 * Protocol recovered from KasmAudioInputWebSocketHandler (tornado; Basic auth is
 * injected by the panel proxy; sample_rate must be 8000..96000).
 *
 * Mic is OFF until the user clicks the floating button (privacy + the browser
 * permission prompt needs a gesture). Nothing is captured or sent otherwise.
 */
(function () {
  'use strict';
  if (window.__prismMicBooted) return;
  window.__prismMicBooted = true;

  function baseDir() { var p = location.pathname; return p.slice(0, p.lastIndexOf('/') + 1); }

  var ctx = null, ws = null, node = null, sink = null, stream = null;
  var state = 'off'; // off | connecting | on

  function setState(s) { state = s; render(); }

  function stop() {
    try { if (ws) { ws.onclose = null; ws.close(); } } catch (e) {}
    try { if (node) node.disconnect(); } catch (e) {}
    try { if (sink) sink.disconnect(); } catch (e) {}
    try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (ctx) ctx.close(); } catch (e) {}
    ws = node = sink = stream = ctx = null;
    setState('off');
  }

  async function start() {
    if (state !== 'off') return;
    setState('connecting');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
      var rate = Math.min(96000, Math.max(8000, Math.round(ctx.sampleRate)));
      var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(proto + location.host + baseDir() + 'kasmmic?sample_rate=' + rate);
      ws.binaryType = 'arraybuffer';

      var src = ctx.createMediaStreamSource(stream);
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = function (e) {
        if (!ws || ws.readyState !== 1) return;
        var f = e.inputBuffer.getChannelData(0);
        var pcm = new Int16Array(f.length);
        for (var i = 0; i < f.length; i++) {
          var s = f[i] < -1 ? -1 : f[i] > 1 ? 1 : f[i];
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        try { ws.send(pcm.buffer); } catch (x) {}
      };
      // ScriptProcessor only fires while connected to the graph; route through a
      // muted gain node so nothing is echoed back to the local speakers.
      sink = ctx.createGain(); sink.gain.value = 0;
      src.connect(node); node.connect(sink); sink.connect(ctx.destination);

      ws.onopen = function () { setState('on'); };
      ws.onclose = function () { if (state !== 'off') stop(); };
      ws.onerror = function () {};
    } catch (e) {
      try { console.warn('[PRISM mic] start failed:', e); } catch (x) {}
      stop();
    }
  }

  function toggle() { if (state === 'on' || state === 'connecting') stop(); else start(); }

  // --- floating toggle button ---
  var btn;
  function render() {
    if (!btn) return;
    var label = state === 'on' ? '🎤 Mic on' : state === 'connecting' ? '🎤 …' : '🎙️ Mic off';
    btn.textContent = label;
    btn.setAttribute('aria-pressed', state === 'on' ? 'true' : 'false');
    btn.style.background = state === 'on' ? '#e5544b' : 'rgba(30,34,44,.85)';
    btn.title = state === 'on' ? 'Microphone is live — click to mute' : 'Enable microphone in this desktop';
  }
  function mount() {
    btn = document.createElement('button');
    btn.id = 'prism-mic-btn';
    btn.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483000;'
      + 'font:600 12px -apple-system,Segoe UI,Roboto,sans-serif;color:#fff;'
      + 'border:1px solid rgba(255,255,255,.25);border-radius:999px;padding:7px 12px;'
      + 'cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);backdrop-filter:blur(4px);';
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggle(); });
    document.body.appendChild(btn);
    render();
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', mount);
  else mount();
  window.addEventListener('beforeunload', stop);
})();
