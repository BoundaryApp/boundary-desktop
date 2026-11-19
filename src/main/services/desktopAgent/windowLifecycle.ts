/**
 * Whether closing Boundary's window hides it instead (ADR 0058 §1): with the desktop button on,
 * on macOS, unless the app is quitting or installing an update, which need the window to close.
 */
export function shouldHideOnClose(input: {
  switchOn: boolean;
  platform: NodeJS.Platform;
  quitting: boolean;
  installingUpdate: boolean;
}): boolean {
  return input.switchOn && input.platform === 'darwin' && !input.quitting && !input.installingUpdate;
}
