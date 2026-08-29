import {clearSession, saveSession} from './storage';
import {API_BASE_URL} from './config';
import type {AuthSession} from './types';

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let currentSession: AuthSession | null = null;
let sessionListener: ((session: AuthSession | null) => void) | null = null;
let refreshPromise: Promise<AuthSession> | null = null;

export const configureApiSession = (
  session: AuthSession | null,
  listener?: (next: AuthSession | null) => void,
) => {
  currentSession = session ? {...session, apiBaseUrl: API_BASE_URL} : null;
  if (listener) sessionListener = listener;
};

const parseResponse = async (response: Response) => {
  const text = await response.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  return body;
};

export const riderLogin = async (email: string, password: string): Promise<AuthSession> => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/auth/rider-login`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({email: email.trim().toLowerCase(), password}),
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check the API address and internet connection.');
  }
  const body = await parseResponse(response);
  if (!response.ok) throw new ApiError(body?.message || 'Sign in failed.', response.status, body?.code);
  if (!body.accessToken || !body.refreshToken || body.user?.role !== 'rider') {
    throw new ApiError('The server returned an invalid rider session.');
  }
  const session: AuthSession = {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    apiBaseUrl: API_BASE_URL,
    user: body.user,
  };
  currentSession = session;
  await saveSession(session);
  return session;
};

const refreshSession = async (): Promise<AuthSession> => {
  if (!currentSession) throw new ApiError('Your session has ended.', 401);
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const response = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({refreshToken: currentSession!.refreshToken}),
      });
      const body = await parseResponse(response);
      if (!response.ok || !body.accessToken || !body.refreshToken) {
        throw new ApiError(body?.message || 'Your session has expired.', response.status, body?.code);
      }
      const next = {...currentSession!, apiBaseUrl: API_BASE_URL, accessToken: body.accessToken, refreshToken: body.refreshToken, user: body.user || currentSession!.user};
      currentSession = next;
      await saveSession(next);
      sessionListener?.(next);
      return next;
    })().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
};

export const apiRequest = async <T = any>(path: string, init: RequestInit = {}, retry = true): Promise<T> => {
  if (!currentSession) throw new ApiError('Please sign in again.', 401);
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${currentSession.accessToken}`,
        ...(init.headers || {}),
      },
    });
  } catch {
    throw new ApiError('No connection to the tracking server.');
  }
  if (response.status === 401 && retry) {
    try {
      await refreshSession();
      return apiRequest<T>(path, init, false);
    } catch (error) {
      currentSession = null;
      await clearSession();
      sessionListener?.(null);
      throw error;
    }
  }
  const body = await parseResponse(response);
  if (!response.ok) throw new ApiError(body?.message || 'The request failed.', response.status, body?.code);
  return body as T;
};

export const logoutRider = async () => {
  const session = currentSession;
  currentSession = null;
  if (session) {
    fetch(`${API_BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({refreshToken: session.refreshToken}),
    }).catch(() => {});
  }
  await clearSession();
  sessionListener?.(null);
};
