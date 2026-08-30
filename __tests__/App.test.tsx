import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(async () => ({isConnected: true})),
    addEventListener: jest.fn(() => () => undefined),
  },
}));
jest.mock('expo-application', () => ({nativeApplicationVersion: '1.0.0'}));
jest.mock('expo-battery', () => ({getBatteryLevelAsync: jest.fn(async () => 1)}));
jest.mock('expo-constants', () => ({__esModule: true, default: {expoConfig: {version: '1.0.0'}}}));
jest.mock('expo-device', () => ({manufacturer: 'Test', modelName: 'Test', osVersion: '1'}));
jest.mock('expo-notifications', () => ({getPermissionsAsync: jest.fn(async () => ({granted: true}))}));
jest.mock('socket.io-client', () => ({io: jest.fn(() => ({on: jest.fn(), emit: jest.fn(), disconnect: jest.fn()}))}));
jest.mock('react-native-safe-area-context', () => {
  return {
    SafeAreaProvider: ({children}: {children: React.ReactNode}) => children,
    useSafeAreaInsets: () => ({top: 0, right: 0, bottom: 0, left: 0}),
  };
});
jest.mock('../src/tracking', () => ({
  configureNotifications: jest.fn(async () => undefined),
  flushLocationQueue: jest.fn(async () => 0),
  getCurrentLocation: jest.fn(),
  isTracking: jest.fn(async () => 'stopped'),
  openLocationSettings: jest.fn(),
  requestTrackingPermissions: jest.fn(async () => ({granted: true, backgroundAvailable: false, backgroundGranted: false})),
  startTracking: jest.fn(async () => 'foreground'),
  stopTracking: jest.fn(async () => undefined),
}));

test('renders the rider login screen when no secure session exists', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<App />);
    await new Promise<void>(resolve => setImmediate(() => resolve()));
  });
  const rendered = JSON.stringify(renderer!.toJSON());
  expect(rendered).toContain('CENCISS');
  expect(rendered).toContain('Delivery');
});
