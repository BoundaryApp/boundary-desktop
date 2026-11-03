# Camera and microphone access

Nothing in the app asks for media yet, so these steps call the preload API and `getUserMedia` from DevTools. Open DevTools with **View > Toggle Developer Tools**, or Option-Command-I. Run the signed steps on a Mac that hasn't answered the prompts for this build's bundle id. To start over, reset the answers with the bundle id the build uses (`com.boundary.desktop` unless `BOUNDARY_APP_ID` set another):

```bash
tccutil reset Camera com.boundary.desktop && tccutil reset Microphone com.boundary.desktop
```

## Signed build

1. Check the build carries the usage strings and entitlements.

   ```bash
   plutil -p /Applications/Boundary.app/Contents/Info.plist | grep -E 'NS(Camera|Microphone)UsageDescription'
   ```

   ```bash
   codesign -d --entitlements - /Applications/Boundary.app 2>/dev/null | grep -E 'device\.(camera|audio-input)'
   ```

   Both usage strings and both entitlements are listed.

2. In the DevTools console, run `await window.electronAPI.media.getAccess()`. It returns `{ camera: 'not-determined', microphone: 'not-determined' }`.
3. Run `await window.electronAPI.media.requestAccess('microphone')`. The macOS prompt appears once and shows the microphone usage string. Click **Allow**. It returns `'granted'`.
4. Run the same line again. No prompt appears and it returns `'granted'`.
5. Run `await window.electronAPI.media.requestAccess('camera')` and click **Don't Allow**. It returns `'denied'`, and running it again returns `'denied'` with no prompt.
6. Run `const mic = await navigator.mediaDevices.getUserMedia({ audio: true })`. It resolves, and the menu bar shows the microphone indicator. Run `mic.getTracks().forEach((t) => t.stop())` and the indicator goes away.
7. Run `await navigator.mediaDevices.getUserMedia({ video: true })`. It rejects with `NotAllowedError`, no prompt appears, and the app keeps running.
8. In System Settings, Privacy & Security, Camera, turn the app on. Quit and reopen it, then run `const cam = await navigator.mediaDevices.getUserMedia({ video: true })`. It resolves and the camera light comes on. Run `cam.getTracks().forEach((t) => t.stop())`.

The handlers log nothing. If the renderer crashed or reloaded during these steps, the debug log records it (use the instance's name in place of `Boundary` for a build with another name):

```bash
grep -n "render-process-gone\|did-fail-load" ~/Library/Logs/Boundary/boundary-debug.log | tail -20
```

## Unsigned dev build

1. Run `bun run dev`. The app opens as before.
2. In DevTools, run `await window.electronAPI.media.getAccess()`. It returns a status for each device without error. macOS attributes a dev build's access to Electron or the terminal that started it, so the values can differ from the signed build's.
3. Run `const mic = await navigator.mediaDevices.getUserMedia({ audio: true })`. It resolves, or macOS prompts for the terminal or Electron first; neither crashes the app. Run `mic?.getTracks().forEach((t) => t.stop())` afterwards.
4. Copy a message from a chat with its copy button. The clipboard holds the text.
