import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import {Linking, Platform} from 'react-native';
import {API_BASE_URL} from './config';
import {loadSession} from './storage';
import type {GeoLocation, RiderLocationPoint} from './types';

export const LOCATION_TASK_NAME = 'cenciss-rider-background-location';
const LOCATION_QUEUE_KEY = '@cenciss-rider/location-queue';
const TRACKING_MODE_KEY = '@cenciss-rider/tracking-mode';
const LAST_ASSIGNMENT_KEY = '@cenciss-rider/last-assignment-id';
const LAST_ASSIGNMENT_CHECK_KEY = '@cenciss-rider/last-assignment-check';
const MAX_QUEUE_SIZE = 1_000;
const ASSIGNMENT_CHECK_INTERVAL_MS = 30_000;

export type TrackingMode = 'stopped' | 'foreground' | 'background';
export type TrackingPermissionResult = {
  granted: boolean;
  backgroundAvailable: boolean;
  backgroundGranted: boolean;
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

const stopForServerState = async (status: number, body: any) => {
  if (status === 403 || body?.code === 'FEATURE_DISABLED' || body?.code === 'NO_ACTIVE_SHIFT') {
    await stopTracking();
    return true;
  }
  return false;
};

export const flushLocationQueue = () => withQueueLock(async () => {
  const session = await loadSession();
  if (!session) return 0;
  let queue = await loadLocationQueue();
  let uploaded = 0;

  while (queue.length > 0) {
    const batch = queue.slice(0, 100);
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}/api/rider/locations/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({points: batch}),
      });
    } catch {
      break;
    }
    const body = await parseResponse(response);
    if (!response.ok) {
      await stopForServerState(response.status, body);
      break;
    }
    uploaded += batch.length;
    queue = queue.slice(batch.length);
    await saveLocationQueue(queue);
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

const checkForNewAssignment = async () => {
  const now = Date.now();
  const lastCheck = Number(await AsyncStorage.getItem(LAST_ASSIGNMENT_CHECK_KEY)) || 0;
  if (now - lastCheck < ASSIGNMENT_CHECK_INTERVAL_MS) return;
  await AsyncStorage.setItem(LAST_ASSIGNMENT_CHECK_KEY, String(now));
  const session = await loadSession();
  if (!session) return;
  try {
    const response = await fetch(`${API_BASE_URL}/api/rider/orders`, {
      headers: {Authorization: `Bearer ${session.accessToken}`},
    });
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

export const queueAndSyncLocations = async (locations: Location.LocationObject[]) => {
  if (!locations.length) return;
  const level = await batteryPercent();
  await withQueueLock(async () => {
    const queue = await loadLocationQueue();
    await saveLocationQueue([
      ...queue,
      ...locations.map(location => toLocationPoint(location, level)),
    ]);
  });
  await flushLocationQueue();
  await checkForNewAssignment();
};

if (!TaskManager.isTaskDefined(LOCATION_TASK_NAME)) {
  TaskManager.defineTask(LOCATION_TASK_NAME, async ({data, error}) => {
    if (error) return;
    const locations = (data as {locations?: Location.LocationObject[]} | undefined)?.locations || [];
    await queueAndSyncLocations(locations);
  });
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

export const requestTrackingPermissions = async (): Promise<TrackingPermissionResult> => {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) {
    return {granted: false, backgroundAvailable: false, backgroundGranted: false};
  }
  await configureNotifications();
  const backgroundAvailable = await isBackgroundTrackingAvailable();
  if (!backgroundAvailable) {
    return {granted: true, backgroundAvailable: false, backgroundGranted: false};
  }
  const background = await Location.requestBackgroundPermissionsAsync();
  return {
    granted: background.granted,
    backgroundAvailable: true,
    backgroundGranted: background.granted,
  };
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
        notificationTitle: 'Cenciss Rider · On duty',
        notificationBody: 'Your delivery route is being recorded.',
        notificationColor: '#4f46e5',
        killServiceOnDestroy: false,
      },
    });
  }
  await AsyncStorage.setItem(TRACKING_MODE_KEY, 'background');
  return 'background' as const;
};

const startForegroundTracking = async () => {
  foregroundSubscription?.remove();
  foregroundSubscription = await Location.watchPositionAsync(
    {accuracy: Location.Accuracy.High, timeInterval: 10_000, distanceInterval: 0},
    location => { queueAndSyncLocations([location]).catch(() => {}); },
  );
  await AsyncStorage.setItem(TRACKING_MODE_KEY, 'foreground');
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
  await AsyncStorage.setItem(TRACKING_MODE_KEY, 'stopped');
  return 'stopped';
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
  await saveLocationQueue([]);
  await AsyncStorage.setItem(TRACKING_MODE_KEY, 'stopped');
};

export const getCurrentLocation = async (): Promise<GeoLocation> => {
  const result = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
    mayShowUserSettingsDialog: true,
  });
  return toGeoLocation(result);
};

export const openLocationSettings = () => Linking.openSettings();
