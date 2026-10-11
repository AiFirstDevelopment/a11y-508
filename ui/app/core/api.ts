import { Injectable } from '@angular/core';

export const SECRET_KEY = 'a11y508.secret';
export const SECRET_HEADER = 'X-A11y-508-Secret';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any) {
    super(message);
  }
}

// Moves the per-launch secret from the address bar into sessionStorage.
export function adoptSecretFromUrl(): void {
  const m = /(?:^#|&)secret=([0-9a-f]+)/.exec(location.hash);
  if (!m) return;
  try {
    sessionStorage.setItem(SECRET_KEY, m[1]);
  } catch {}
  history.replaceState(null, '', location.pathname + location.search);
}

export function secret(): string {
  try {
    return sessionStorage.getItem(SECRET_KEY) || '';
  } catch {
    return '';
  }
}

@Injectable({ providedIn: 'root' })
export class Api {
  headers(extra: Record<string, string> = {}): Record<string, string> {
    return { [SECRET_HEADER]: secret(), ...extra };
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method,
      headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `HTTP ${res.status}`, data);
    return data as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  stream(path: string, signal: AbortSignal): Promise<Response> {
    return fetch(path, { headers: this.headers(), signal, credentials: 'same-origin' });
  }
}
