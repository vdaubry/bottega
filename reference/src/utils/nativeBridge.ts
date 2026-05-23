/**
 * NATIVE BRIDGE
 * =============
 *
 * Utility for communicating with the native iOS app via WKWebView's message handler.
 * Used to send user authentication events to the native app for OneSignal user linking.
 *
 * The native iOS app listens for messages on the "nativeApp" handler and processes:
 * - loginUser: Links the iOS device to the backend user via OneSignal external_id
 * - logoutUser: Unlinks the iOS device from the current user
 */

/** Check if the PWA is running inside the native iOS app. */
export function isNativeApp(): boolean {
  return !!(window.webkit?.messageHandlers?.nativeApp);
}

/**
 * Send user ID to native app for OneSignal login.
 * Call this after successful user authentication.
 */
export function loginUserToNative(userId: string | number): void {
  if (isNativeApp() && userId) {
    try {
      // Prefix with "user_" to avoid OneSignal blocking simple IDs like "1"
      const externalId = `user_${userId}`;
      window.webkit!.messageHandlers!.nativeApp!.postMessage({
        action: 'loginUser',
        userId: externalId,
      });
      console.log('[NativeBridge] Sent loginUser with userId:', externalId);
    } catch (error) {
      console.error('[NativeBridge] Failed to send loginUser:', error);
    }
  }
}

/** Notify native app of user logout to unlink the OneSignal subscription. */
export function logoutUserFromNative(): void {
  if (isNativeApp()) {
    try {
      window.webkit!.messageHandlers!.nativeApp!.postMessage({
        action: 'logoutUser',
      });
      console.log('[NativeBridge] Sent logoutUser');
    } catch (error) {
      console.error('[NativeBridge] Failed to send logoutUser:', error);
    }
  }
}
