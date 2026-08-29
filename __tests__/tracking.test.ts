import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import {API_BASE_URL} from '../src/config';
import {loadSession} from '../src/storage';
import {
  queueAndSyncLocations,
  requestTrackingPermissions,
  startTracking,
  stopTracking,
} from '../src/tracking';

jest.mock('@react-native-async-storage/async-storage', () => {
  const values = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => values.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => { values.set(key, value); }),
      removeItem: jest.fn(async (key: string) => { values.delete(key); }),
      clear: jest.fn(async () => { values.clear(); }),
    },
  };
});

jest.mock('expo-battery', () => ({getBatteryLevelAsync: jest.fn(async () => 0.75)}));
jest.mock('expo-location', () => ({
  Accuracy: {High: 4},
  getForegroundPermissionsAsync: jest.fn(async () => ({granted: true})),
  requestForegroundPermissionsAsync: jest.fn(async () => ({granted: true})),
  getBackgroundPermissionsAsync: jest.fn(async () => ({granted: false})),
  requestBackgroundPermissionsAsync: jest.fn(async () => ({granted: false})),
  hasStartedLocationUpdatesAsync: jest.fn(async () => false),
  startLocationUpdatesAsync: jest.fn(async () => undefined),
  stopLocationUpdatesAsync: jest.fn(async () => undefined),
  watchPositionAsync: jest.fn(async () => ({remove: jest.fn()})),
  getCurrentPositionAsync: jest.fn(),
}));
jest.mock('expo-notifications', () => ({
  AndroidImportance: {HIGH: 4},
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => undefined),
  getPermissionsAsync: jest.fn(async () => ({granted: true, canAskAgain: true})),
  requestPermissionsAsync: jest.fn(async () => ({granted: true})),
  scheduleNotificationAsync: jest.fn(async () => 'notification-id'),
}));
jest.mock('expo-task-manager', () => ({
  isTaskDefined: jest.fn(() => false),
  defineTask: jest.fn(),
  isAvailableAsync: jest.fn(async () => false),
}));
jest.mock('../src/storage', () => ({
  loadSession: jest.fn(async () => ({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    apiBaseUrl: 'https://api.example.com',
    user: {name: 'Rider', email: 'rider@example.com', role: 'rider'},
  })),
}));

const response = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  text: async () => JSON.stringify(body),
}) as Response;

beforeEach(async () => {
  await stopTracking();
  await AsyncStorage.clear();
  jest.clearAllMocks();
  (TaskManager.isAvailableAsync as jest.Mock).mockResolvedValue(false);
  (Location.getForegroundPermissionsAsync as jest.Mock).mockResolvedValue({granted: true});
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({granted: true});
  (Location.getBackgroundPermissionsAsync as jest.Mock).mockResolvedValue({granted: false});
  (Location.requestBackgroundPermissionsAsync as jest.Mock).mockResolvedValue({granted: false});
  (Location.hasStartedLocationUpdatesAsync as jest.Mock).mockResolvedValue(false);
  (Location.watchPositionAsync as jest.Mock).mockResolvedValue({remove: jest.fn()});
  (loadSession as jest.Mock).mockResolvedValue({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    apiBaseUrl: 'https://api.example.com',
    user: {name: 'Rider', email: 'rider@example.com', role: 'rider'},
  });
  globalThis.fetch = jest.fn();
});

test('uses foreground tracking in Expo Go when TaskManager is unavailable', async () => {
  await expect(requestTrackingPermissions()).resolves.toEqual({
    granted: true,
    backgroundAvailable: false,
    backgroundGranted: false,
  });
  await expect(startTracking()).resolves.toBe('foreground');
  expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1);
  expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
});

test('starts the Expo background location task in an APK build', async () => {
  (TaskManager.isAvailableAsync as jest.Mock).mockResolvedValue(true);
  (Location.requestBackgroundPermissionsAsync as jest.Mock).mockResolvedValue({granted: true});
  (Location.getBackgroundPermissionsAsync as jest.Mock).mockResolvedValue({granted: true});

  await expect(requestTrackingPermissions()).resolves.toEqual({
    granted: true,
    backgroundAvailable: true,
    backgroundGranted: true,
  });
  await expect(startTracking()).resolves.toBe('background');
  expect(Location.startLocationUpdatesAsync).toHaveBeenCalledWith(
    'cenciss-rider-background-location',
    expect.objectContaining({timeInterval: 10_000, foregroundService: expect.any(Object)}),
  );
});

test('uploads captured points and removes them from the offline queue', async () => {
  (globalThis.fetch as jest.Mock)
    .mockResolvedValueOnce(response({success: true, data: {accepted: 1}}))
    .mockResolvedValueOnce(response({success: true, data: []}));

  await queueAndSyncLocations([{
    coords: {
      latitude: 31.5204,
      longitude: 74.3587,
      altitude: 210,
      accuracy: 6,
      altitudeAccuracy: 8,
      heading: 90,
      speed: 4,
    },
    timestamp: Date.now(),
    mocked: false,
  }]);

  expect(globalThis.fetch).toHaveBeenCalledWith(
    `${API_BASE_URL}/api/rider/locations/batch`,
    expect.objectContaining({method: 'POST'}),
  );
  const request = (globalThis.fetch as jest.Mock).mock.calls[0][1];
  const points = JSON.parse(request.body).points;
  expect(points[0]).toMatchObject({latitude: 31.5204, longitude: 74.3587, batteryLevel: 75, source: 'gps'});
  await expect(AsyncStorage.getItem('@cenciss-rider/location-queue')).resolves.toBe('[]');
});
