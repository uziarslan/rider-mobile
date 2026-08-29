import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import {API_BASE_URL} from './config';
import type {AuthSession, PendingAction} from './types';

const SESSION_KEY = 'cenciss-rider-session';
const DEVICE_KEY = '@cenciss-rider/device-id';
const ACTIONS_KEY = '@cenciss-rider/pending-actions';
export const saveSession = async (session: AuthSession) => {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify({...session, apiBaseUrl: API_BASE_URL}));
};

export const loadSession = async (): Promise<AuthSession | null> => {
  const value = await SecureStore.getItemAsync(SESSION_KEY);
  if (!value) return null;
  try {
    return {...JSON.parse(value), apiBaseUrl: API_BASE_URL} as AuthSession;
  } catch {
    await clearSession();
    return null;
  }
};

export const clearSession = () => SecureStore.deleteItemAsync(SESSION_KEY);

export const getDeviceId = async () => {
  const existing = await AsyncStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const next = `android-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  await AsyncStorage.setItem(DEVICE_KEY, next);
  return next;
};

export const loadPendingActions = async (): Promise<PendingAction[]> => {
  try {
    return JSON.parse((await AsyncStorage.getItem(ACTIONS_KEY)) || '[]') as PendingAction[];
  } catch {
    return [];
  }
};

export const savePendingActions = (actions: PendingAction[]) =>
  AsyncStorage.setItem(ACTIONS_KEY, JSON.stringify(actions.slice(-100)));
