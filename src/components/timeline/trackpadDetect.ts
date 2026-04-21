/**
 * Trackpad two-finger scroll and pinch detection.
 *
 * Why this exists: the binding matrix lets the user bind `wheel` to
 * whatever they want (scroll, zoom, nudge, nothing). That's fine for a
 * real mouse wheel, but trackpad mechanics are non-negotiable — a
 * two-finger swipe must scroll and a pinch must zoom, regardless of
 * which preset is active. Otherwise users on macOS laptops get stuck
 * with a tool that doesn't pan when they swipe.
 *
 * Detection:
 *  - **Pinch (Chrome/Edge/Firefox-mac)**: the browser synthesises a
 *    `wheel` event with `ctrlKey=true` even when Ctrl isn't physically
 *    pressed. We track the *real* Ctrl state with window-level keydown
 *    / keyup / blur / visibilitychange listeners — if `e.ctrlKey` is
 *    true but Ctrl isn't actually down, the gesture is a pinch.
 *  - **Safari pinch**: dispatched as `gesturestart` / `gesturechange` /
 *    `gestureend`. Handled separately in the viewport hook; this
 *    module only handles `wheel`.
 *  - **Trackpad scroll vs mouse wheel**: trackpad `wheel` events are
 *    pixel-mode (`deltaMode === 0`) with small, often non-integer
 *    deltas; diagonal scrolls set both `deltaX` and `deltaY`. Mouse
 *    wheels produce line or pixel deltas that are integer multiples of
 *    ~100 (Chrome/Firefox) or similar. This heuristic is the same shape
 *    Figma and Perfetto use; it's not perfect on Linux/X11 but the
 *    matrix still covers those cases because the user can pick a
 *    mouse-wheel-friendly preset.
 */

export type WheelKind = 'trackpad-scroll' | 'trackpad-pinch' | 'mouse-wheel'

/**
 * Tracks real Ctrl-key state with window-level listeners. Returns an
 * object with `isCtrlDown()` and `dispose()`. Call `dispose` to detach.
 *
 * We intentionally don't just rely on the wheel event's own `ctrlKey`
 * because pinch gestures on macOS Chrome synthesise `ctrlKey=true`
 * without any real keypress.
 */
export interface CtrlTracker {
  isCtrlDown(): boolean
  dispose(): void
}

export function createCtrlTracker(): CtrlTracker {
  let ctrlDown = false

  const onDown = (e: KeyboardEvent): void => {
    if (e.key === 'Control') ctrlDown = true
  }
  const onUp = (e: KeyboardEvent): void => {
    if (e.key === 'Control') ctrlDown = false
  }
  const onBlur = (): void => {
    // Ctrl state can desync if the user Ctrl-tabs away; reset on blur.
    ctrlDown = false
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') ctrlDown = false
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }
  }

  return {
    isCtrlDown: () => ctrlDown,
    dispose: () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', onDown)
        window.removeEventListener('keyup', onUp)
        window.removeEventListener('blur', onBlur)
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }
    },
  }
}

/**
 * Threshold (px) below which a pixel-mode wheel delta is considered
 * "small" — trackpads typically emit 1–30px per frame, physical mouse
 * wheels emit 100+. The cutoff is conservative so a flicked trackpad
 * gesture still registers as trackpad even at its fastest.
 */
const TRACKPAD_DELTA_THRESHOLD = 50

/**
 * Classify a wheel event. Called at the top of the wheel handler; the
 * caller short-circuits the binding matrix for trackpad scroll/pinch.
 *
 * @param e        The wheel event.
 * @param ctrlDown True iff the real Ctrl key is physically held.
 */
export function classifyWheel(
  e: WheelEvent,
  ctrlDown: boolean,
): WheelKind {
  // Pinch: the browser sets ctrlKey=true on the synthetic wheel event
  // that represents a pinch gesture. If we see ctrlKey=true but the
  // real Ctrl isn't down, it's a pinch — zoom regardless of preset.
  if (e.ctrlKey && !ctrlDown) return 'trackpad-pinch'

  // Non-pixel delta modes (line/page) are produced by physical wheels
  // or keyboard-driven scroll; always treat as mouse-wheel so the
  // binding matrix applies.
  if (e.deltaMode !== 0) return 'mouse-wheel'

  // Diagonal scroll (both axes non-zero) is a trackpad signature —
  // physical wheels produce exactly one axis at a time.
  if (e.deltaX !== 0 && e.deltaY !== 0) return 'trackpad-scroll'

  // Small pixel deltas come from trackpads. Large ones come from
  // mouse wheels (even Chrome's "smooth scroll" on a physical wheel
  // batches into ~100px chunks).
  const magnitude = Math.max(Math.abs(e.deltaX), Math.abs(e.deltaY))
  if (magnitude < TRACKPAD_DELTA_THRESHOLD) return 'trackpad-scroll'

  // Fractional deltas are trackpad (momentum). Integer multiples of
  // ~100 are mouse-wheel.
  if (!Number.isInteger(e.deltaY) || !Number.isInteger(e.deltaX)) {
    return 'trackpad-scroll'
  }

  return 'mouse-wheel'
}

export const __test__ = {TRACKPAD_DELTA_THRESHOLD}
