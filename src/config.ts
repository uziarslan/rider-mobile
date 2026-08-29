const normalizeUrl = (value: string) => value.trim().replace(/\/+$/, '');

export const API_BASE_URL = normalizeUrl(
  process.env.EXPO_PUBLIC_API_BASE_URL || 'http://10.0.2.2:4000',
);

