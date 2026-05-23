/**
 * True when the primary pointer is "coarse" — i.e. a touch screen (phones,
 * tablets) rather than a mouse/trackpad.
 *
 * We use this to decide whether it's safe to programmatically `.focus()` a
 * textarea after inserting text (e.g. a voice transcript). On touch devices,
 * stealing focus leaves the field focused while the soft keyboard is closed;
 * iOS Safari then consumes the user's next tap to open the keyboard instead of
 * activating whatever they actually tapped (e.g. a "Create"/"Send" submit
 * button), so the button appears dead. Desktops have no such trap, so we keep
 * the auto-focus convenience there.
 */
export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(pointer: coarse)').matches;
}
