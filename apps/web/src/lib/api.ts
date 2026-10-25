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
  const body = (await res.json().catch(() => null)) as {
    error?: { code: string; message: string };
  } | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'REQUEST_FAILED',
      body?.error?.message ?? `Request failed (${res.status})`,
    );
  }
  return body as T;
}

/** Safe retry only for idempotent reads; writes carry idempotency keys instead of being auto-retried. */
async function request<T>(method: string, path: string, body?: unknown, retries = 0): Promise<T> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(await authHeader()),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return await parse<T>(res);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (retries > 0) return request<T>(method, path, body, retries - 1);
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Could not reach the server. Check your connection and try again.',
    );
  }
}

/**
 * POST that answers with server-sent events. `onEvent` sees every event; the promise resolves with the `done`
 * payload and rejects with an ApiError for an `error` event or a broken stream.
 */
async function stream<T>(
  path: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Could not reach the server. Check your connection and try again.',
    );
  }
  if (!res.ok || !res.body) return parse<T>(res); // ordinary JSON error (validation, auth, ...)

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: { value: T } | null = null;
  const handle = (block: string) => {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    const payload: unknown = JSON.parse(data);
    if (event === 'error') {
      const e = payload as { status?: number; code?: string; message?: string };
      throw new ApiError(
        e.status ?? 500,
        e.code ?? 'REQUEST_FAILED',
        e.message ?? 'Request failed',
      );
    }
    if (event === 'done') result = { value: payload as T };
    else onEvent(event, payload);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        handle(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
      }
      if (done) break;
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'The connection was interrupted. Please try again.');
  }
  if (!result) {
    throw new ApiError(0, 'NETWORK_ERROR', 'The connection ended before the reply was ready.');
  }
  return (result as { value: T }).value;
}

export const api = {
  stream,
  get: <T>(path: string) => request<T>('GET', path, undefined, 1),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
  async upload<T>(path: string, file: File): Promise<T> {
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: await authHeader(),
        body: form,
      });
      return await parse<T>(res);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(0, 'NETWORK_ERROR', 'Upload failed. Check your connection and try again.');
    }
  },
};

export const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : 'Something went wrong';
