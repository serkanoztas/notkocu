/**
 * expo-share-intent (iOS) opens the app with a "notkocu://dataUrl=..." link that is not a route.
 * Send it to the root; the share intent itself is read by ShareIntentProvider and handled in _layout.
 * (Android shares do not come through this path.)
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return path.includes("dataUrl=") ? "/" : path;
}
