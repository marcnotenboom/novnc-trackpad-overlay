// noVNC Trackpad Overlay — see README.md for usage and gotchas.
// MIT License.
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

    // Keyboard button — overlay covers the noVNC sidebar tab, so we need our
    // own way to summon the soft keyboard. Focusing noVNC's hidden input pops
    // it up; blurring hides it.
    var kbd = document.createElement('button');
    kbd.textContent = 'kbd';
    Object.assign(kbd.style, {
      position: 'fixed', top: '8px', right: '76px',
      zIndex: '100002', padding: '6px 10px',
      background: 'rgba(124,58,237,0.85)', color: '#fff',
      border: 'none', borderRadius: '6px', font: '12px sans-serif',
    });
    function toggleKbd(e) {
      if (e) e.stopPropagation();
      var input = document.getElementById('noVNC_keyboardinput');
      if (!input) return;
      if (document.activeElement === input) {
        input.blur();
        kbd.style.background = 'rgba(124,58,237,0.85)';
      } else {
        input.focus();
        try { var l = input.value.length; input.setSelectionRange(l, l); } catch (_) {}
        kbd.style.background = 'rgba(34,197,94,0.85)';
      }
    }
    kbd.addEventListener('click', toggleKbd);
    kbd.addEventListener('touchstart', function(e) { e.stopPropagation(); }, { passive: true });

    document.body.appendChild(overlay);
    document.body.appendChild(dot);
    document.body.appendChild(btn);
    document.body.appendChild(kbd);

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
      kbd.style.display = on ? 'block' : 'none';
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
