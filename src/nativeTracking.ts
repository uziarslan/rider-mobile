import {NativeModules, Platform} from 'react-native';

export type NativeTrackingStatus = {
  active: boolean;
  lastLocationAt: number;
  lastUploadAt: number;
  lastServiceSignalAt: number;
  queueDepth: number;
  consecutiveFailures: number;
  lastError: string;
};

type NativeTrackingModule = {
  start(options: {apiBaseUrl: string; accessToken: string; deviceId: string}): Promise<boolean>;
  stop(): Promise<boolean>;
  getStatus(): Promise<NativeTrackingStatus>;
};

const module = Platform.OS === 'android'
  ? NativeModules.CencissBackgroundTracking as NativeTrackingModule | undefined
  : undefined;

export const isNativeTrackingAvailable = () => Boolean(module);

export const startNativeTracking = async (options: {
  apiBaseUrl: string;
  accessToken: string;
  deviceId: string;
}) => {
  if (!module) return false;
  await module.start(options);
  return true;
};

export const stopNativeTracking = async () => {
  if (!module) return false;
  await module.stop();
  return true;
};

export const getNativeTrackingStatus = async (): Promise<NativeTrackingStatus | null> => {
  if (!module) return null;
  try {
    return await module.getStatus();
  } catch {
    return null;
  }
};
