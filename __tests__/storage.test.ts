import * as SecureStore from 'expo-secure-store';
import {API_BASE_URL} from '../src/config';
import {loadSession, saveSession} from '../src/storage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
  },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

const oldSession = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  apiBaseUrl: 'https://old-tunnel.ngrok-free.app',
  user: {name: 'Rider', email: 'rider@example.com', role: 'rider' as const},
};

beforeEach(() => {
  jest.clearAllMocks();
});

test('replaces a stored server URL with the configured environment URL', async () => {
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue(JSON.stringify(oldSession));

  await expect(loadSession()).resolves.toMatchObject({apiBaseUrl: API_BASE_URL});
});

test('persists the configured environment URL instead of a session override', async () => {
  await saveSession(oldSession);

  const stored = JSON.parse((SecureStore.setItemAsync as jest.Mock).mock.calls[0][1]);
  expect(stored.apiBaseUrl).toBe(API_BASE_URL);
});
