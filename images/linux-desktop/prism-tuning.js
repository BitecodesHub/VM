/* PRISM Virtual Desktop — smoothness default.
 *
 * KasmVNC's stream settings live in localStorage (per browser) and are DERIVED
 * from a master "video quality" preset (0=Static, 1=Low, 2=Medium, 3=High,
 * 4=Extreme). The stock default is Medium → 24 fps and video downscaled to
 * 960x540, which feels sluggish. On connect the client recomputes framerate /
 * resolution / quality FROM the preset, so seeding those derived keys is futile;
 * the preset is the only lever that sticks.
 *
 * We seed the Extreme preset ONCE per version (60 fps, 1920x1080 video, crisp
 * quality floor). A version marker means a user's later manual change is kept.
 * The server is already provisioned for this (Xvnc -FrameRate 60,
 * -MaxVideoResolution 1920x1080), and KasmVNC only encodes changed regions, so
 * a static desktop still costs ~nothing — the higher ceiling only spends the
 * CPU the removed webcam busy-loop freed, during actual motion.
 */
(function () {
  'use strict';
  var VERSION = 'prism-smooth-v2';
  try {
    if (localStorage.getItem('prism_tuned') === VERSION) return;
    localStorage.setItem('video_quality', '4');   // Extreme — master preset
    localStorage.setItem('enable_webp', 'true');   // efficient codec
    localStorage.setItem('enable_threading', 'true');
    localStorage.setItem('prism_tuned', VERSION);
  } catch (e) { /* private mode / storage disabled — client keeps its defaults */ }
})();
