# noVNC Trackpad Overlay

A drop-in JavaScript snippet that turns the noVNC web client into a real
**trackpad-style** input on a phone or tablet: the cursor stays where it was
and finger movement nudges it relatively, instead of touch-tap teleporting
the pointer under your finger (the noVNC default, which is brutal on small
screens).

Same UX as the abandoned [noVNC PR #1835](https://github.com/novnc/noVNC/pull/1835),
but achieved without forking noVNC — by injecting a transparent overlay into
whatever wrapper hosts the noVNC page (a React Native WebView, an Android
`WebView`, a Capacitor / Cordova shell, a Tauri window, or just a `<script>`
tag on your own noVNC page).

## Why this repo exists

I built this for myself, for one specific setup:

> Samsung Galaxy Fold 7 → React Native + `react-native-webview` → noVNC
> 1.6.0 (Chromium-in-noVNC container behind an authenticated reverse proxy).

That's a narrow corner of the world. **You probably want something
slightly different** — maybe a different phone, a different mobile
framework, a Capacitor app, a PWA, or a desktop with a touchscreen.
Rather than try to write a one-size-fits-all library, I'm publishing the
working snippet plus a precise description of what it does and *why* the
non-obvious bits are non-obvious. The goal is that you can:

1. Read this README in 5 minutes.
2. Hand the entire repo to an LLM (Claude Opus 4.7, GPT-5, etc.) along
   with a short description of *your* host environment.
3. Get a working version of the overlay tailored to your setup.

The README is written to be high-signal for AI: explicit gotchas,
explicit DOM IDs, no hand-waving, no "you might want to…". If the
snippet doesn't fit your wrapper as-is, the AI will have everything it
needs to adapt it.

## Gesture map

| Gesture                              | Action                          |
|--------------------------------------|---------------------------------|
| 1-finger drag                        | Move cursor                     |
| 1-finger tap (no movement)           | Left click                      |
| Two quick 1-finger taps              | Double-click (native)           |
| 1-finger long press (>500 ms)        | Start drag — release on lift    |
| 2-finger tap (no movement)           | Right click                     |
| 2-finger vertical drag               | Scroll                          |
| Tap "kbd" button (top-right)         | Pop / hide the on-screen keyboard |
| Tap "TP" button (top-right)          | Toggle overlay (off → noVNC native touch) |

## How it works

1. Wait for noVNC's canvas to appear (it's created dynamically inside
   `#noVNC_container` *after* the WebSocket handshake — there is no static
   `id`, so we poll for `#noVNC_container canvas`).
2. Add a transparent `<div>` at `position: fixed`, `z-index: 100000`,
   covering the viewport with `touch-action: none`. This swallows touches
   before they reach noVNC's own touch handler.
3. Maintain a virtual cursor `(cx, cy)` in viewport coordinates, drawn as a
   small dot via another `<div>`.
4. On `touchmove`, multiply the delta by a sensitivity factor and update
   `(cx, cy)`.
5. Synthesise `mousemove` / `mousedown` / `mouseup` / `wheel` `MouseEvent`
   and `WheelEvent` objects on the canvas at the virtual cursor position.
   noVNC listens for normal mouse events on the canvas, so it forwards them
   to the VNC server as if they came from a real mouse.
6. After every press, hide `#noVNC_mouse_capture_elem` (see Gotcha below).
7. Provide a "TP on/off" toggle so the user can fall back to noVNC's
   native touch behavior on the rare page where the overlay misbehaves.

The only assumptions about noVNC internals are the existence of
`#noVNC_container` and a `<canvas>` child, plus the `setCapture()`
emulation div described below. Both have been stable across noVNC
1.2.x – 1.6.x.

## The snippet

Self-contained — no dependencies, no build step. Inject as a single string
into the WebView after page load.

```js
(function() {
  if (window.__trackpadInstalled) return;
  window.__trackpadInstalled = true;

  // Tweak these to taste.
  var SENSITIVITY = 1.4;     // px-of-cursor per px-of-finger
  var TAP_THRESHOLD_PX = 10; // movement that disqualifies a tap
  var LONG_PRESS_MS = 500;   // hold time before drag mode engages

  function init() {
    var container = document.getElementById('noVNC_container');
    if (!container || !container.querySelector('canvas')) { setTimeout(init, 200); return; }
    function getCanvas() {
      // Re-resolve every event: noVNC may rebuild the canvas after a remote
      // resolution change, and a stale reference would silently swallow events.
      var c = document.getElementById('noVNC_container');
      return c && c.querySelector('canvas');
    }

    // z-index must beat noVNC's mouse-capture proxy
    // (#noVNC_mouse_capture_elem, z-index 10000). On every synthetic
    // mousedown noVNC creates that fullscreen div to emulate the legacy
    // Element.setCapture(); without overpowering it, every touch after the
    // first click would land on the capture div instead of our overlay
    // and the cursor would freeze.
    var overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      zIndex: '100000', touchAction: 'none', background: 'transparent',
    });

    var dot = document.createElement('div');
    Object.assign(dot.style, {
      position: 'fixed', width: '14px', height: '14px',
      borderRadius: '50%', border: '2px solid #fff',
      background: 'rgba(124,58,237,0.85)', pointerEvents: 'none',
      zIndex: '100001', transform: 'translate(-50%,-50%)',
      boxShadow: '0 0 6px rgba(0,0,0,0.6)',
    });

    var btn = document.createElement('button');
    btn.textContent = 'TP on';
    Object.assign(btn.style, {
      position: 'fixed', top: '8px', right: '8px',
      zIndex: '100002', padding: '6px 10px',
      background: 'rgba(124,58,237,0.85)', color: '#fff',
      border: 'none', borderRadius: '6px', font: '12px sans-serif',
    });

    document.body.appendChild(overlay);
    document.body.appendChild(dot);
    document.body.appendChild(btn);

    var enabled = true;
    var cx = window.innerWidth / 2;
    var cy = window.innerHeight / 2;
    var lastX = 0, lastY = 0;
    var startX = 0, startY = 0;
    var moved = false;
    var longPressT = null;
    var dragHeld = false;
    var twoFingerActive = false;
    var twoFingerMoved = false;
    var twoFingerY = 0;

    function placeDot() {
      cx = Math.max(0, Math.min(window.innerWidth - 1, cx));
      cy = Math.max(0, Math.min(window.innerHeight - 1, cy));
      dot.style.left = cx + 'px';
      dot.style.top = cy + 'px';
    }

    function fireMouse(type, btnIdx) {
      var c = getCanvas();
      if (!c) return;
      var e = new MouseEvent(type, {
        clientX: cx, clientY: cy, screenX: cx, screenY: cy,
        button: btnIdx || 0,
        buttons: type === 'mousedown' ? (btnIdx === 2 ? 2 : 1)
               : type === 'mouseup' ? 0
               : (dragHeld ? 1 : 0),
        bubbles: true, cancelable: true, view: window,
      });
      c.dispatchEvent(e);
    }

    function hideCaptureProxy() {
      // noVNC's setCapture() emulation leaves #noVNC_mouse_capture_elem
      // visible until a real DOM mouseup bubbles to its proxy listener.
      // Our synthetic mouseup goes directly to the canvas and never reaches
      // the proxy, so we close it ourselves after every press cycle.
      var cap = document.getElementById('noVNC_mouse_capture_elem');
      if (cap) cap.style.display = 'none';
    }

    function fireClick(btnIdx) {
      // Position the cursor first, then press+release synchronously. Using
      // setTimeout for the release leaves the button stuck "down" on the
      // remote when the click triggers a re-layout (e.g. a navigation).
      fireMouse('mousemove', 0);
      fireMouse('mousedown', btnIdx);
      fireMouse('mouseup', btnIdx);
      hideCaptureProxy();
    }

    function fireWheel(dy) {
      var c = getCanvas();
      if (!c) return;
      var e = new WheelEvent('wheel', {
        clientX: cx, clientY: cy,
        deltaY: dy, deltaMode: 0,
        bubbles: true, cancelable: true, view: window,
      });
      c.dispatchEvent(e);
    }

    function setEnabled(on) {
      enabled = on;
      overlay.style.pointerEvents = on ? 'auto' : 'none';
      dot.style.display = on ? 'block' : 'none';
      btn.textContent = on ? 'TP on' : 'TP off';
      btn.style.background = on ? 'rgba(124,58,237,0.85)' : 'rgba(82,82,91,0.85)';
    }

    btn.addEventListener('click', function(e) { e.stopPropagation(); setEnabled(!enabled); });
    btn.addEventListener('touchstart', function(e) { e.stopPropagation(); }, { passive: true });

    overlay.addEventListener('touchstart', function(e) {
      if (!enabled) return;
      e.preventDefault();

      if (e.touches.length === 2) {
        twoFingerActive = true;
        twoFingerMoved = false;
        twoFingerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        if (longPressT) { clearTimeout(longPressT); longPressT = null; }
        return;
      }

      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      lastX = startX = t.clientX;
      lastY = startY = t.clientY;
      moved = false;

      // Long-press with no movement = start drag (button stays held until lift).
      longPressT = setTimeout(function() {
        if (!moved && !dragHeld) {
          dragHeld = true;
          fireMouse('mousedown', 0);
        }
      }, LONG_PRESS_MS);
    }, { passive: false });

    overlay.addEventListener('touchmove', function(e) {
      if (!enabled) return;
      e.preventDefault();

      if (twoFingerActive && e.touches.length === 2) {
        var midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        var dy = midY - twoFingerY;
        if (Math.abs(dy) > 4) {
          twoFingerMoved = true;
          fireWheel(-dy);
          twoFingerY = midY;
        }
        return;
      }

      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      var dx = (t.clientX - lastX) * SENSITIVITY;
      var dy2 = (t.clientY - lastY) * SENSITIVITY;
      lastX = t.clientX; lastY = t.clientY;
      cx += dx; cy += dy2;
      placeDot();

      if (Math.hypot(t.clientX - startX, t.clientY - startY) > TAP_THRESHOLD_PX) {
        moved = true;
        if (longPressT) { clearTimeout(longPressT); longPressT = null; }
      }

      fireMouse('mousemove', 0);
    }, { passive: false });

    overlay.addEventListener('touchend', function(e) {
      if (!enabled) return;
      e.preventDefault();
      if (longPressT) { clearTimeout(longPressT); longPressT = null; }

      // Release long-press drag.
      if (dragHeld && e.touches.length === 0) {
        fireMouse('mouseup', 0);
        dragHeld = false;
        hideCaptureProxy();
        return;
      }

      // Two-finger gesture ended.
      if (twoFingerActive && e.touches.length === 0) {
        if (!twoFingerMoved) fireClick(2);
        twoFingerActive = false;
        twoFingerMoved = false;
        return;
      }

      // Single tap with no movement = left click. Two quick taps therefore
      // produce a native double-click via two consecutive click events.
      if (e.touches.length === 0 && !moved && e.changedTouches.length === 1 && !twoFingerActive) {
        fireClick(0);
      }
    }, { passive: false });

    placeDot();
  }
  init();
})();
```

The same code is in [`overlay.js`](./overlay.js) for direct download.

## My personal integration (reference)

```tsx
// React Native + react-native-webview, on a Samsung Galaxy Fold 7.
import { WebView } from 'react-native-webview';
import { TRACKPAD_OVERLAY_JS } from './trackpad';   // the snippet + `true;`

<WebView
  source={{ uri: 'https://my-server/path/to/vnc.html?autoconnect=1' }}
  injectedJavaScript={TRACKPAD_OVERLAY_JS}
  originWhitelist={['*']}
  javaScriptEnabled
  domStorageEnabled
/>
```

The trailing `true;` after the snippet is required by `react-native-webview`
so the injected script returns a defined value; other wrappers don't need it.

## How to ask an AI to adapt this

Paste the entire repo (or the README + `overlay.js`) into Claude / GPT and
add a prompt like:

> I have a noVNC client at `<URL>` that I render inside `<your wrapper —
> Capacitor WebView, Tauri window, plain `<iframe>`, etc.>`. Adapt the
> trackpad overlay so:
>
> - it injects on every page load of the noVNC URL
> - the toggle button is at `<position>` and looks like `<style>`
> - sensitivity defaults to `<X>` for my display resolution
>
> Keep the gesture map and the noVNC capture-proxy fix unchanged.

Models that can read both the snippet and noVNC's `core/rfb.js` /
`core/util/events.js` will tailor it correctly. Claude Opus 4.7 wrote
this version on the first try given a screenshot of the broken behaviour
and a single sentence of context.

## Gotcha: the noVNC capture proxy

If the cursor freezes after the very first click, the cause is almost
certainly noVNC's `setCapture()` emulation. On every `mousedown` it inserts
`<div id="noVNC_mouse_capture_elem">` at `z-index: 10000`, full-screen,
`display: ""`. That div is supposed to be torn down by a real DOM `mouseup`
that bubbles into its proxy listener — but our synthetic `mouseup` is
dispatched straight onto the canvas and never reaches the proxy. Result:
the capture div stays visible, sits on top of our overlay (which was at
9998–10000), and swallows every subsequent touch.

The snippet handles this in two ways:

1. Overlay / dot / toggle button at `z-index: 100000+` so they always
   outrank the capture div.
2. `hideCaptureProxy()` — call after every mouseup to hide
   `#noVNC_mouse_capture_elem` ourselves.

If you port the snippet to a much older noVNC, double-check the capture
element's id and z-index in `core/util/events.js`.

## Tuning

* **Sensitivity** — `SENSITIVITY = 1.4` is a good default for a ~1080p
  phone screen viewing a 1280×768 desktop. For lower-resolution remote
  desktops bump it to 2.0+; for matching resolutions drop to 1.0.
* **Long-press time** — `LONG_PRESS_MS = 500`. Lower it (300–400) if
  right-click feels slow; raise if accidental right-clicks happen.
* **Tap threshold** — `TAP_THRESHOLD_PX = 10`. Movement smaller than this
  is still considered a tap. Increase on high-DPI screens.

## Known limitations

* **Pinch-zoom is intercepted.** The current snippet uses two fingers for
  scroll wheel; if you want noVNC's pinch-to-zoom on the canvas, exclude
  two-finger gestures from the overlay or detect pinch vs. pan.
* **The overlay covers everything.** noVNC's own sidebar is *underneath*.
  Tap "TP off" first to interact with the noVNC control bar, or extend
  the overlay to leave a margin where the control bar lives.
* **Cursor drift on rotation.** The virtual cursor position is in
  viewport coordinates; on orientation change you may want to re-center
  via `cx = window.innerWidth/2; cy = window.innerHeight/2`.
* **Soft-keyboard on Android.** Synthesising mouse events doesn't pop up
  the keyboard on its own. The overlay solves this with a `kbd` toggle
  button that focuses (and re-blurs) noVNC's hidden `#noVNC_keyboardinput`
  textarea, which the OS treats as a real text input.

## License

MIT. See [LICENSE](./LICENSE).
