import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import * as BackgroundTask from 'expo-background-task';
import * as Battery from 'expo-battery';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import {Linking, Platform} from 'react-native';
import {API_BASE_URL} from './config';
import {getDeviceId, loadSession, saveSession} from './storage';
import type {AuthSession, GeoLocation, RiderLocationPoint} from './types';

export const LOCATION_TASK_NAME = 'cenciss-rider-background-location';
export const TRACKING_WATCHDOG_TASK_NAME = 'cenciss-rider-tracking-watchdog';
const LOCATION_QUEUE_KEY = '@cenciss-rider/location-queue';
const TRACKING_MODE_KEY = '@cenciss-rider/tracking-mode';
const TRACKING_HEALTH_KEY = '@cenciss-rider/tracking-health';
const LAST_ASSIGNMENT_KEY = '@cenciss-rider/last-assignment-id';
const LAST_ASSIGNMENT_CHECK_KEY = '@cenciss-rider/last-assignment-check';
const LAST_REPAIR_NOTIFICATION_KEY = '@cenciss-rider/last-repair-notification';
const MAX_QUEUE_SIZE = 1_000;
const ASSIGNMENT_CHECK_INTERVAL_MS = 30_000;
const CALLBACK_REPAIR_AFTER_MS = 180_000;
const REQUEST_TIMEOUT_MS = 15_000;
const WATCHDOG_INTERVAL_MINUTES = 15;
const WATCHDOG_LOCATION_TIMEOUT_MS = 20_000;
const REPAIR_NOTIFICATION_INTERVAL_MS = 30 * 60_000;
const REPAIR_NOTIFICATION_FAILURE_COUNT = 3;

export type TrackingMode = 'stopped' | 'foreground' | 'background';
export type TrackingPermissionResult = {
  granted: boolean;
  backgroundAvailable: boolean;
  backgroundGranted: boolean;
};
export type TrackingHealth = {
  mode: TrackingMode;
  serviceStartedAt?: string;
  lastTaskCallbackAt?: string;
  lastUploadAt?: string;
  lastWatchdogAt?: string;
  lastError?: string;
  queueDepth: number;
  backgroundLocationGranted?: boolean;
  batteryOptimizationEnabled?: boolean;
  lowPowerMode?: boolean;
  consecutiveUploadFailures?: number;
};
export type TrackingRepairResult = {mode: TrackingMode; restarted: boolean};
export type TrackingReadiness = {
  backgroundAvailable: boolean;
  backgroundGranted: boolean;
  foregroundGranted: boolean;
  preciseLocation: boolean;
  batteryOptimizationEnabled: boolean;
  lowPowerMode: boolean;
};

let foregroundSubscription: Location.LocationSubscription | null = null;
let queueLock: Promise<unknown> = Promise.resolve();

const withQueueLock = <T,>(work: () => Promise<T>): Promise<T> => {
  const next = queueLock.then(work, work);
  queueLock = next.then(() => undefined, () => undefined);
  return next;
};

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

const loadLocationQueue = async (): Promise<RiderLocationPoint[]> => {
  try {
    const rows = JSON.parse((await AsyncStorage.getItem(LOCATION_QUEUE_KEY)) || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
};

const saveLocationQueue = (points: RiderLocationPoint[]) =>
  AsyncStorage.setItem(LOCATION_QUEUE_KEY, JSON.stringify(points.slice(-MAX_QUEUE_SIZE)));

const loadTrackingHealth = async (): Promise<TrackingHealth> => {
  try {
    const value = JSON.parse((await AsyncStorage.getItem(TRACKING_HEALTH_KEY)) || '{}');
    return {
      mode: ['background', 'foreground', 'stopped'].includes(value?.mode) ? value.mode : 'stopped',
      serviceStartedAt: value?.serviceStartedAt,
      lastTaskCallbackAt: value?.lastTaskCallbackAt,
      lastUploadAt: value?.lastUploadAt,
      lastWatchdogAt: value?.lastWatchdogAt,
      lastError: value?.lastError,
      queueDepth: Number.isFinite(Number(value?.queueDepth)) ? Number(value.queueDepth) : 0,
      backgroundLocationGranted: typeof value?.backgroundLocationGranted === 'boolean' ? value.backgroundLocationGranted : undefined,
      batteryOptimizationEnabled: typeof value?.batteryOptimizationEnabled === 'boolean' ? value.batteryOptimizationEnabled : undefined,
      lowPowerMode: typeof value?.lowPowerMode === 'boolean' ? value.lowPowerMode : undefined,
      consecutiveUploadFailures: Number.isFinite(Number(value?.consecutiveUploadFailures)) ? Number(value.consecutiveUploadFailures) : 0,
    };
  } catch {
    return {mode: 'stopped', queueDepth: 0};
  }
};

const updateTrackingHealth = async (values: Partial<TrackingHealth>) => {
  const current = await loadTrackingHealth();
  const next = {...current, ...values};
  await AsyncStorage.setItem(TRACKING_HEALTH_KEY, JSON.stringify(next));
  return next;
};

const trackingErrorText = (error: unknown) => {
  if (error instanceof Error) return error.message.slice(0, 500);
  if (typeof error === 'string') return error.slice(0, 500);
  try { return JSON.stringify(error).slice(0, 500); } catch { return 'Unknown tracking error'; }
};

const recordTrackingError = (error: unknown) => updateTrackingHealth({lastError: trackingErrorText(error)});

const powerRestrictions = async () => {
  const [batteryOptimizationEnabled, lowPowerMode] = await Promise.all([
    Platform.OS === 'android'
      ? Battery.isBatteryOptimizationEnabledAsync().catch(() => false)
      : Promise.resolve(false),
    Battery.isLowPowerModeEnabledAsync().catch(() => false),
  ]);
  return {batteryOptimizationEnabled, lowPowerMode};
};

const withTimeout = async <T,>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const fetchWithTimeout = async (url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...init, signal: controller.signal});
  } catch (error) {
    if ((error as {name?: string})?.name === 'AbortError') {
      throw new Error('The tracking server request timed out. It will retry automatically.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const batteryPercent = async () => {
  try {
    const level = await Battery.getBatteryLevelAsync();
    return level >= 0 ? Math.round(level * 100) : undefined;
  } catch {
    return undefined;
  }
};

export const toGeoLocation = (location: Location.LocationObject): GeoLocation => ({
  latitude: location.coords.latitude,
  longitude: location.coords.longitude,
  accuracy: location.coords.accuracy ?? undefined,
  speed: location.coords.speed ?? undefined,
  heading: location.coords.heading ?? undefined,
  altitude: location.coords.altitude ?? undefined,
  isMock: location.mocked ?? false,
  recordedAtEpoch: location.timestamp,
});

const toLocationPoint = (
  location: Location.LocationObject,
  level?: number,
): RiderLocationPoint => ({
  ...toGeoLocation(location),
  clientPointId: makeId(),
  batteryLevel: level,
  source: 'gps',
  recordedAt: new Date(location.timestamp || Date.now()).toISOString(),
});

const parseResponse = async (response: Response) => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
};

let trackingRefreshPromise: Promise<AuthSession> | null = null;

const refreshTrackingSession = async (session: AuthSession): Promise<AuthSession> => {
  if (!trackingRefreshPromise) {
    trackingRefreshPromise = (async () => {
      const response = await fetchWithTimeout(`${API_BASE_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({refreshToken: session.refreshToken}),
      });
      const body = await parseResponse(response);
      if (!response.ok || !body?.accessToken || !body?.refreshToken) {
        throw new Error(body?.message || 'The rider session could not be refreshed in the background.');
      }
      const next: AuthSession = {
        ...session,
        apiBaseUrl: API_BASE_URL,
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        user: body.user || session.user,
      };
      await saveSession(next);
      return next;
    })().finally(() => { trackingRefreshPromise = null; });
  }
  return trackingRefreshPromise;
};

const authorizedTrackingRequest = async (
  path: string,
  init: RequestInit,
  session: AuthSession,
  retry = true,
): Promise<{response: Response; session: AuthSession}> => {
  const response = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.accessToken}`,
      ...(init.headers || {}),
    },
  });
  if (response.status !== 401 || !retry) return {response, session};
  const refreshed = await refreshTrackingSession(session);
  return authorizedTrackingRequest(path, init, refreshed, false);
};

const stopForServerState = async (status: number, body: any) => {
  if (status === 403 || body?.code === 'FEATURE_DISABLED' || body?.code === 'NO_ACTIVE_SHIFT') {
    await stopTracking();
    return true;
  }
  return false;
};

export const flushLocationQueue = () => withQueueLock(async () => {
  let session = await loadSession();
  if (!session) return 0;
  let queue = await loadLocationQueue();
  let uploaded = 0;

  while (queue.length > 0) {
    const batch = queue.slice(0, 100);
    const health = await loadTrackingHealth();
    let response: Response;
    try {
      const request = await authorizedTrackingRequest('/api/rider/locations/batch', {
        method: 'POST',
        body: JSON.stringify({
          points: batch,
          deviceId: await getDeviceId(),
          trackingEnabled: health.mode !== 'stopped',
          backgroundLocationGranted: health.backgroundLocationGranted,
          batteryOptimizationEnabled: health.batteryOptimizationEnabled,
          lowPowerMode: health.lowPowerMode,
          trackingHealth: {
            mode: health.mode,
            queueDepth: queue.length,
            taskCallbackAt: health.lastTaskCallbackAt,
            watchdogAt: health.lastWatchdogAt,
            lastError: health.lastError || '',
            consecutiveUploadFailures: health.consecutiveUploadFailures || 0,
          },
        }),
      }, session);
      response = request.response;
      session = request.session;
    } catch (error) {
      const failures = Number(health.consecutiveUploadFailures || 0) + 1;
      await updateTrackingHealth({
        lastError: trackingErrorText(error),
        consecutiveUploadFailures: failures,
      });
      if (failures >= REPAIR_NOTIFICATION_FAILURE_COUNT) await showTrackingRepairNotification();
      break;
    }
    const body = await parseResponse(response);
    if (!response.ok) {
      await stopForServerState(response.status, body);
      const failures = Number(health.consecutiveUploadFailures || 0) + 1;
      await updateTrackingHealth({
        lastError: String(body?.message || `Location upload failed (${response.status}).`).slice(0, 500),
        consecutiveUploadFailures: failures,
      });
      if (failures >= REPAIR_NOTIFICATION_FAILURE_COUNT) await showTrackingRepairNotification();
      break;
    }
    uploaded += batch.length;
    queue = queue.slice(batch.length);
    await saveLocationQueue(queue);
    await updateTrackingHealth({
      lastUploadAt: new Date().toISOString(),
      lastError: '',
      queueDepth: queue.length,
      consecutiveUploadFailures: 0,
    });
  }
  return uploaded;
});

const showAssignmentNotification = async (orderNumber: string) => {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'New delivery assigned',
        body: `Open order ${orderNumber} and accept it.`,
        sound: 'default',
        data: {screen: 'deliveries'},
      },
      trigger: null,
    });
  } catch {
    // The app still displays the assignment when opened if notification access is off.
  }
};

async function showTrackingRepairNotification() {
  const now = Date.now();
  const lastShownAt = Number(await AsyncStorage.getItem(LAST_REPAIR_NOTIFICATION_KEY)) || 0;
  if (now - lastShownAt < REPAIR_NOTIFICATION_INTERVAL_MS) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Delivery tracking needs attention',
        body: 'Open Cenciss Delivery to restore live GPS while your duty shift is active.',
        sound: 'default',
        data: {screen: 'profile'},
      },
      trigger: null,
    });
    await AsyncStorage.setItem(LAST_REPAIR_NOTIFICATION_KEY, String(now));
  } catch {
    // The dashboard still receives the watchdog diagnostic when alerts are denied.
  }
}

const checkForNewAssignment = async () => {
  const now = Date.now();
  const lastCheck = Number(await AsyncStorage.getItem(LAST_ASSIGNMENT_CHECK_KEY)) || 0;
  if (now - lastCheck < ASSIGNMENT_CHECK_INTERVAL_MS) return;
  await AsyncStorage.setItem(LAST_ASSIGNMENT_CHECK_KEY, String(now));
  const session = await loadSession();
  if (!session) return;
  try {
    const {response} = await authorizedTrackingRequest('/api/rider/orders', {method: 'GET'}, session);
    const body = await parseResponse(response);
    if (!response.ok) {
      await stopForServerState(response.status, body);
      return;
    }
    const assigned = Array.isArray(body?.data)
      ? body.data.find((row: any) => row?.active && row?.status === 'assigned')
      : null;
    const previousId = await AsyncStorage.getItem(LAST_ASSIGNMENT_KEY);
    if (assigned?._id && assigned._id !== previousId) {
      await AsyncStorage.setItem(LAST_ASSIGNMENT_KEY, String(assigned._id));
      await showAssignmentNotification(String(assigned.orderNumber || ''));
    }
  } catch {
    // Assignment polling is best effort; Socket.IO also updates the open app.
  }
};

export const queueAndSyncLocations = async (
  locations: Location.LocationObject[],
  mode: TrackingMode = 'background',
  {markTaskCallback = true}: {markTaskCallback?: boolean} = {},
) => {
  await updateTrackingHealth({
    mode,
    ...(markTaskCallback ? {lastTaskCallbackAt: new Date().toISOString()} : {}),
    lastError: '',
  });
  if (!locations.length) return;
  const level = await batteryPercent();
  await withQueueLock(async () => {
    const queue = await loadLocationQueue();
    const next = [
      ...queue,
      ...locations.map(location => toLocationPoint(location, level)),
    ].slice(-MAX_QUEUE_SIZE);
    await saveLocationQueue(next);
    await updateTrackingHealth({queueDepth: next.length});
  });
  await flushLocationQueue();
  await checkForNewAssignment();
};

if (!TaskManager.isTaskDefined(LOCATION_TASK_NAME)) {
  TaskManager.defineTask(LOCATION_TASK_NAME, async ({data, error}) => {
    if (error) {
      await recordTrackingError(error);
      return;
    }
    try {
      const locations = (data as {locations?: Location.LocationObject[]} | undefined)?.locations || [];
      await queueAndSyncLocations(locations, 'background');
    } catch (taskError) {
      await recordTrackingError(taskError);
    }
  });
}

if (!TaskManager.isTaskDefined(TRACKING_WATCHDOG_TASK_NAME)) {
  TaskManager.defineTask(TRACKING_WATCHDOG_TASK_NAME, async () => runTrackingWatchdog());
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export const configureNotifications = async () => {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('rider-assignments', {
        name: 'Delivery assignments',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 150, 250],
      });
      await Notifications.setNotificationChannelAsync('tracking-alerts', {
        name: 'Tracking service alerts',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 300, 180, 300],
      });
    }
    const existing = await Notifications.getPermissionsAsync();
    if (!existing.granted && existing.canAskAgain) {
      await Notifications.requestPermissionsAsync();
    }
  } catch {
    // Notification denial must not prevent GPS or delivery work.
  }
};

export const isBackgroundTrackingAvailable = async () => {
  try {
    return await TaskManager.isAvailableAsync();
  } catch {
    return false;
  }
};

export const getTrackingReadiness = async (): Promise<TrackingReadiness> => {
  const [foreground, background, backgroundAvailable, power] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync().catch(() => ({granted: false} as Location.PermissionResponse)),
    isBackgroundTrackingAvailable(),
    powerRestrictions(),
  ]);
  const preciseLocation = foreground.granted && foreground.android?.accuracy !== 'coarse';
  await updateTrackingHealth({
    backgroundLocationGranted: background.granted,
    ...power,
  });
  return {
    backgroundAvailable,
    backgroundGranted: background.granted,
    foregroundGranted: foreground.granted,
    preciseLocation,
    ...power,
  };
};

export const requestTrackingPermissions = async (): Promise<TrackingPermissionResult> => {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) {
    await updateTrackingHealth({backgroundLocationGranted: false, lastError: 'Precise location permission is denied.'});
    return {granted: false, backgroundAvailable: false, backgroundGranted: false};
  }
  await configureNotifications();
  const backgroundAvailable = await isBackgroundTrackingAvailable();
  if (!backgroundAvailable) {
    await updateTrackingHealth({backgroundLocationGranted: false});
    return {granted: true, backgroundAvailable: false, backgroundGranted: false};
  }
  const background = await Location.requestBackgroundPermissionsAsync();
  const power = await powerRestrictions();
  await updateTrackingHealth({
    backgroundLocationGranted: background.granted,
    ...power,
    lastError: background.granted ? '' : 'Background location permission is denied.',
  });
  return {
    granted: background.granted,
    backgroundAvailable: true,
    backgroundGranted: background.granted,
  };
};

const registerTrackingWatchdog = async () => {
  try {
    if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return false;
    if (!(await TaskManager.isTaskRegisteredAsync(TRACKING_WATCHDOG_TASK_NAME))) {
      await BackgroundTask.registerTaskAsync(TRACKING_WATCHDOG_TASK_NAME, {
        minimumInterval: WATCHDOG_INTERVAL_MINUTES,
      });
    }
    return true;
  } catch {
    // The foreground location service remains the primary tracker. Some
    // Expo Go/device combinations do not expose WorkManager registration.
    return false;
  }
};

const unregisterTrackingWatchdog = async () => {
  try {
    if (await TaskManager.isTaskRegisteredAsync(TRACKING_WATCHDOG_TASK_NAME)) {
      await BackgroundTask.unregisterTaskAsync(TRACKING_WATCHDOG_TASK_NAME);
    }
  } catch {
    // Best effort during shift shutdown.
  }
};

const startBackgroundTracking = async () => {
  if (!(await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME))) {
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.High,
      timeInterval: 10_000,
      distanceInterval: 0,
      deferredUpdatesInterval: 20_000,
      deferredUpdatesDistance: 0,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Cenciss Delivery · On duty',
        notificationBody: 'Background GPS is active. Keep this app installed and do not force-stop it.',
        notificationColor: '#4f46e5',
        killServiceOnDestroy: false,
      },
    });
  }
  await AsyncStorage.setItem(TRACKING_MODE_KEY, 'background');
  await updateTrackingHealth({mode: 'background', serviceStartedAt: new Date().toISOString(), lastTaskCallbackAt: undefined, lastError: ''});
  await registerTrackingWatchdog();
  return 'background' as const;
};

const startForegroundTracking = async () => {
  foregroundSubscription?.remove();
  foregroundSubscription = await Location.watchPositionAsync(
    {accuracy: Location.Accuracy.High, timeInterval: 10_000, distanceInterval: 0},
    location => { queueAndSyncLocations([location], 'foreground').catch(recordTrackingError); },
  );
  await AsyncStorage.setItem(TRACKING_MODE_KEY, 'foreground');
  await updateTrackingHealth({mode: 'foreground', serviceStartedAt: new Date().toISOString(), lastTaskCallbackAt: undefined, lastError: ''});
  return 'foreground' as const;
};

export const startTracking = async (): Promise<TrackingMode> => {
  const foreground = await Location.getForegroundPermissionsAsync();
  if (!foreground.granted) throw new Error('Precise location permission is required.');
  if (await isBackgroundTrackingAvailable()) {
    const background = await Location.getBackgroundPermissionsAsync();
    if (background.granted) return startBackgroundTracking();
  }
  return startForegroundTracking();
};

export const isTracking = async (): Promise<TrackingMode> => {
  if (foregroundSubscription) return 'foreground';
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) return 'background';
  } catch {
    // Expo Go on Android does not expose background TaskManager execution.
  }
  // Keep the requested background mode until an explicit duty-stop. Android
  // can briefly report the native task as missing while WorkManager is waking
  // it; replacing the stored intent with "stopped" prevents the watchdog from
  // repairing the service later.
  await updateTrackingHealth({mode: 'stopped'});
  return 'stopped';
};

export const getTrackingHealth = async (): Promise<TrackingHealth> => {
  const [queue, power] = await Promise.all([loadLocationQueue(), powerRestrictions()]);
  const health = await updateTrackingHealth(power);
  return {...health, queueDepth: queue.length};
};

export const trackingHeartbeatPayload = async () => {
  const [level, mode, foreground, background, power] = await Promise.all([
    batteryPercent(),
    isTracking(),
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync().catch(() => ({granted: false} as Location.PermissionResponse)),
    powerRestrictions(),
  ]);
  const permissionAccuracy = foreground.android?.accuracy;
  const locationPermission = !foreground.granted
    ? 'denied'
    : permissionAccuracy === 'coarse' ? 'approximate' : 'precise';
  const health = await updateTrackingHealth({mode, backgroundLocationGranted: background.granted, ...power});
  return {
    deviceId: await getDeviceId(),
    batteryLevel: level,
    trackingEnabled: mode !== 'stopped',
    trackingMode: mode,
    locationPermission,
    backgroundLocationGranted: background.granted,
    batteryOptimizationEnabled: power.batteryOptimizationEnabled,
    lowPowerMode: power.lowPowerMode,
    trackingHealth: {
      mode,
      queueDepth: health.queueDepth,
      taskCallbackAt: health.lastTaskCallbackAt,
      watchdogAt: health.lastWatchdogAt,
      lastError: health.lastError || '',
      consecutiveUploadFailures: health.consecutiveUploadFailures || 0,
    },
  };
};

const postTrackingHeartbeat = async (payload: Awaited<ReturnType<typeof trackingHeartbeatPayload>>) => {
  const session = await loadSession();
  if (!session) return false;
  const {response} = await authorizedTrackingRequest('/api/rider/heartbeat', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, session);
  const body = await parseResponse(response);
  if (!response.ok) {
    await stopForServerState(response.status, body);
    throw new Error(body?.message || `Tracking heartbeat failed (${response.status}).`);
  }
  return true;
};

async function runTrackingWatchdog() {
  const storedMode = await AsyncStorage.getItem(TRACKING_MODE_KEY);
  if (storedMode !== 'background') return BackgroundTask.BackgroundTaskResult.Success;

  const watchdogAt = new Date().toISOString();
  await updateTrackingHealth({lastWatchdogAt: watchdogAt});
  try {
    if (!(await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME))) {
      await startBackgroundTracking();
    }
  } catch (error) {
    await recordTrackingError(error);
  }
  let capturedFreshLocation = false;
  try {
    const location = await withTimeout(
      Location.getCurrentPositionAsync({accuracy: Location.Accuracy.Balanced}),
      WATCHDOG_LOCATION_TIMEOUT_MS,
      'The Android tracking watchdog could not obtain a fresh GPS position.',
    );
    await queueAndSyncLocations([location], 'background', {markTaskCallback: false});
    capturedFreshLocation = true;
  } catch (error) {
    await recordTrackingError(error);
  }

  try {
    const payload = await trackingHeartbeatPayload();
    const health = await loadTrackingHealth();
    const callbackAt = health.lastTaskCallbackAt ? new Date(health.lastTaskCallbackAt).getTime() : 0;
    const callbackFresh = callbackAt > 0 && Date.now() - callbackAt <= CALLBACK_REPAIR_AFTER_MS;
    if (!capturedFreshLocation && !callbackFresh) {
      payload.trackingEnabled = false;
      payload.trackingHealth.lastError = 'Android stopped delivering background GPS callbacks. Open Cenciss Delivery to repair tracking.';
      await showTrackingRepairNotification();
    }
    await postTrackingHeartbeat(payload);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (error) {
    await recordTrackingError(error);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
}

export const ensureTrackingHealthy = async (): Promise<TrackingRepairResult> => {
  const mode = await isTracking();
  if (mode === 'stopped') {
    try {
      return {mode: await startTracking(), restarted: true};
    } catch (error) {
      await recordTrackingError(error);
      throw error;
    }
  }
  if (mode !== 'background') return {mode, restarted: false};
  const health = await loadTrackingHealth();
  const reference = health.lastTaskCallbackAt || health.serviceStartedAt || health.lastUploadAt;
  const referenceTime = reference ? new Date(reference).getTime() : 0;
  if (referenceTime && Date.now() - referenceTime <= CALLBACK_REPAIR_AFTER_MS) {
    return {mode, restarted: false};
  }
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    }
    const repairedMode = await startBackgroundTracking();
    return {mode: repairedMode, restarted: true};
  } catch (error) {
    await recordTrackingError(error);
    throw error;
  }
};

export const stopTracking = async () => {
  foregroundSubscription?.remove();
  foregroundSubscription = null;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    }
  } catch {
    // The location task is unavailable inside Expo Go on Android.
  }
  await unregisterTrackingWatchdog();
  await saveLocationQueue([]);
  await AsyncStorage.setItem(TRACKING_MODE_KEY, 'stopped');
  await updateTrackingHealth({mode: 'stopped', queueDepth: 0, lastError: ''});
};

export const getCurrentLocation = async (): Promise<GeoLocation> => {
  const result = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
    mayShowUserSettingsDialog: true,
  });
  return toGeoLocation(result);
};

export const openLocationSettings = () => Linking.openSettings();

export const openBatterySettings = async () => {
  if (Platform.OS !== 'android') return Linking.openSettings();
  try {
    const applicationId = Application.applicationId;
    if (applicationId === 'com.cenciss.rider') {
      await IntentLauncher.startActivityAsync(
        IntentLauncher.ActivityAction.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
        {data: `package:${applicationId}`},
      );
      return;
    }
    await IntentLauncher.startActivityAsync(
      IntentLauncher.ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS,
    );
  } catch {
    await Linking.openSettings();
  }
};

export const openPowerSaverSettings = async () => {
  if (Platform.OS !== 'android') return Linking.openSettings();
  try {
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.BATTERY_SAVER_SETTINGS);
  } catch {
    await Linking.openSettings();
  }
};
