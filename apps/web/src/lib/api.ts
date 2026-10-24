import { supabase } from './supabase';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? 'REQUEST_FAILED', body?.error?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

/** Safe retry only for idempotent reads; writes carry idempotency keys instead of being auto-retried. */
async function request<T>(method: string, path: string, body?: unknown, retries = 0): Promise<T> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { ...(await authHeader()), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return await parse<T>(res);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (retries > 0) return request<T>(method, path, body, retries - 1);
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection and try again.');
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path, undefined, 1),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
  async upload<T>(path: string, file: File): Promise<T> {
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: await authHeader(), body: form });
      return await parse<T>(res);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(0, 'NETWORK_ERROR', 'Upload failed. Check your connection and try again.');
    }
  },
};

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');
