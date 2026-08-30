# Cenciss Delivery (Expo React Native)

Expo-managed React Native application for outlet riders. Development uses Expo Go; production is distributed privately as a sideloaded Android APK, with no Play Store release required.

The project is pinned to Expo SDK 54 (`expo ~54.0.36`, currently resolved to `54.0.37`; React Native `0.81.5`; React `19.1.0`) and is compatible with the Android Expo Go `54.0.8` client.

## Included behavior

- Rider-role login only, with access and refresh tokens stored by Expo SecureStore.
- Admin/outlet feature enforcement at login and on every rider API request.
- Duty start/end with precise GPS capture and outlet geofence state.
- Expo background location task for the installed APK, including a persistent Android notification while on duty.
- Android battery-optimization detection; installed APK builds require unrestricted battery use before duty can start.
- A WorkManager watchdog that retries queued uploads, obtains a fallback GPS fix when possible, and alerts the rider if Android stopped the foreground tracker.
- Expo Go foreground GPS fallback for developing the screens and API flow on a physical phone.
- A maximum 1,000-point on-device GPS queue and server uploads in batches of 100 after outages.
- Timed network requests and background token refresh so one stalled/expired request cannot permanently jam the GPS queue.
- Tracking health diagnostics for the last Android callback, last successful upload, queued points, permissions, and task/network errors.
- Automatic foreground repair of a registered background task that has stopped delivering callbacks.
- Full live Socket.IO assignment updates for customer details, delivery address, notes, totals, status, and order items, plus reconnect/polling recovery.
- Rider-visible order lines with quantity, variation, item notes, and line amount.
- Tappable delivery headers and a full order-information screen that reloads the canonical sale before display.
- Offline delivery-action queue with idempotent server replay.
- Only these actions: Accept, Picked Up, Delivered, Delivery Failed, Returned to Restaurant.
- Paired Call and WhatsApp customer-contact buttons, plus Google Maps navigation from an assignment.

## Develop with Expo Go

Requirements: Node.js 20.19.4 or newer, an Android phone with Expo Go 54.0.8, and the phone and development computer on the same network.

```sh
cd rider-mobile
npm install
EXPO_PUBLIC_API_BASE_URL=http://YOUR_COMPUTER_LAN_IP:4000 npm start
```

Scan the terminal QR code with Expo Go. For a physical phone, do not use `localhost` or `10.0.2.2`; use the computer's LAN address, such as `http://192.168.1.20:4000`. The address can also be changed under **Server settings** on the rider login screen.

If Metro was already running before the SDK downgrade, stop it and run `npm run start:clear` once. The Metro manifest must report `sdkVersion: 54.0.0`; the installed Expo Go application patch (`54.0.8`) does not need to match the project's resolved `expo` package patch (`54.0.37`).

Expo Go can develop and test login, rider orders, the five delivery actions, Socket.IO updates, offline action replay, and live GPS while the app stays open. Expo Go on Android cannot run TaskManager in the background. The UI therefore labels this as **Foreground / Expo Go** and continues uploading GPS only while Expo Go remains open.

## Verify locked-screen tracking

Locked-screen tracking uses `expo-location` and `expo-task-manager` and must run in an app binary containing this project's native configuration. You can create a local native development build with Continuous Native Generation:

```sh
npx expo run:android --device
```

This generates a local `android/` directory, which is intentionally ignored and can be regenerated from `app.json`.

## Build the private APK

The `preview` and `production` EAS profiles both produce an APK rather than a Play Store AAB:

```sh
npm run build:apk
```

On the first build, Expo will ask you to sign in, create/link the EAS project, and create or select Android signing credentials. Preserve the same signing key for every future update. Set `EXPO_PUBLIC_API_BASE_URL` in the EAS environment to the production HTTPS API address before building.

After the build finishes, download the `.apk`, copy it to each rider phone, open it from the Files app, and allow **Install unknown apps** for that file source. Play Store publication is not required.

The current source is version `1.0.4` (`versionCode` 8). No replacement APK is generated automatically; build it only when the testing round is approved.

## Rider phone setup

1. Install the APK and sign in with a User whose role is `rider`.
2. Set Location to **Allow all the time**, enable precise location, and allow notifications.
3. When prompted, allow Cenciss Delivery to ignore battery optimization. The installed app will not start duty while Android still reports restricted battery use.
4. Start Duty while the app is visible. Android then shows a persistent tracking notification.
5. Do not force-stop the app during duty; Android prevents a force-stopped app from restarting background work.
6. Use **Rider Profile → Check & Repair Tracking** if the persistent notification disappears or the last callback stops updating.
7. On phones with an additional vendor App Launch/Auto-start manager, allow Cenciss Delivery to auto-start and run in the background.

## Verification commands

```sh
npx expo install --check
npm run typecheck
npm run lint
npm test -- --runInBand
npm run export
```
