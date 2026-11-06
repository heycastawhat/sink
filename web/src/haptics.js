// Haptic feedback. Android browsers have the Vibration API. iOS Safari doesn't, but flipping a hidden
// <input type="checkbox" switch> from a tap makes the Taptic Engine tick, so that's the fallback there.
// In the Android app's editor WebView there's no VIBRATE permission, so it asks the app instead, whose haptics
// also follow the system's touch feedback setting.

const PATTERNS = {
  tick: 8,
  select: 12,
  toggle: 14,
  confirm: [12, 50, 18],
  warn: [28, 40, 28],
  heavy: 30,
};

// The app's kinds (Haptics.kt).
const APP_KINDS = { tick: 'tick', select: 'tick', toggle: 'toggle', confirm: 'confirm', warn: 'reject', heavy: 'reject' };

let enabled = true;
try {
  enabled = JSON.parse(localStorage.getItem('haptics')) !== false;
} catch {
  /* private mode etc. */
}

export const hapticsEnabled = () => enabled;
export function setHaptics(on) {
  enabled = on;
  try {
    localStorage.setItem('haptics', JSON.stringify(on));
  } catch {
    /* private mode etc. */
  }
}

let iosTick;
function tickOnIos() {
  if (!iosTick) {
    iosTick = document.createElement('label');
    iosTick.setAttribute('aria-hidden', 'true');
    iosTick.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    iosTick.innerHTML = '<input type="checkbox" switch tabindex="-1" />';
    document.body.append(iosTick);
  }
  iosTick.click();
}

/** A short buzz: 'tick', 'select', 'toggle', 'confirm', 'warn' or 'heavy'. Call it from a tap or key handler. */
export function buzz(kind = 'tick') {
  if (!enabled) return;
  if (window.SinkBridge?.haptic) window.SinkBridge.haptic(APP_KINDS[kind] ?? 'tick');
  else if (navigator.vibrate) navigator.vibrate(PATTERNS[kind] ?? PATTERNS.tick);
  else if (document.body) tickOnIos();
}

// Taps on anything that's a button, so every control feels the same without wiring each one.
const PRESSABLE = 'm3e-button, m3e-icon-button, m3e-fab, m3e-fab-menu-item, m3e-expansion-panel, .tabbar a, .nav-item, .swatch, .note-swatch, .picker-row, .switcher-row, .new-item, .note-card, .folder-tile';
// Destructive ones get a firmer buzz.
const DESTRUCTIVE = '#note-delete, #trash-empty, [data-drop], [data-revoke], [data-forever], [data-confirm-danger]';

document.addEventListener(
  'click',
  (e) => {
    const el = e.target.closest?.(PRESSABLE);
    if (!el || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return;
    buzz(el.matches(DESTRUCTIVE) ? 'warn' : el.matches('m3e-fab') ? 'select' : 'tick');
  },
  true,
);

// Switches and checkboxes.
document.addEventListener('change', (e) => {
  if (e.target.matches?.('m3e-switch, m3e-checkbox, input[type="checkbox"]')) buzz('toggle');
});
