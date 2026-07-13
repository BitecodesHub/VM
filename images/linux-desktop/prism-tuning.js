/* PRISM Virtual Desktop — smoothness defaults.
 *
 * KasmVNC reads its stream settings from localStorage (per browser). A browser
 * that connected to an older build keeps stale, conservative values (e.g. 24 fps,
 * 960x540 video downscale) that make the desktop feel sluggish. This seeds a
 * smooth, crisp profile ONCE per version — it runs before the client reads its
 * settings, and sets a version marker so a user's later manual tweaks are kept.
 *
 * Costs are bounded: KasmVNC only encodes changed regions, so a static desktop
 * at 60 fps costs almost nothing; the higher rate/quality only spends the CPU
 * that the removed webcam busy-loop freed up, during actual motion.
 */
(function () {
  'use strict';
  var VERSION = 'prism-smooth-v1';
  try {
    if (localStorage.getItem('prism_tuned') === VERSION) return;
    var tuned = {
      framerate: '60',              // fluid motion (server ceiling is 60)
      dynamic_quality_min: '7',     // hold a crisp floor instead of dropping to mush
      dynamic_quality_max: '9',
      treat_lossless: '8',
      jpeg_video_quality: '7',
      webp_video_quality: '7',
      max_video_resolution_x: '1920', // do not downscale motion regions (crisp)
      max_video_resolution_y: '1080',
      enable_webp: 'true',
      enable_threading: 'true',
    };
    for (var k in tuned) { if (Object.prototype.hasOwnProperty.call(tuned, k)) localStorage.setItem(k, tuned[k]); }
    localStorage.setItem('prism_tuned', VERSION);
  } catch (e) { /* private mode / storage disabled — client falls back to its defaults */ }
})();
