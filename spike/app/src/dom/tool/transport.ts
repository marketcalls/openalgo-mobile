// THROWAWAY SPIKE. Transport-layer interceptor for the DOM bundle: replaces window.fetch and window.XMLHttpRequest so the unchanged frontend's axios/fetch calls are answered without a server.
//
// Why here and not by replacing frontend modules: the page, its axios client
// (with its CSRF interceptor) and its stores all run exactly as shipped; only
// the wire is swapped. In the real app the same hook point would forward each
// request to the native side (see the 'native' mode) or to the configured
// OpenAlgo server, because relative URLs like '/auth/csrf-token' resolve to
// file:///auth/csrf-token inside a release DOM component.

export interface WireRequest {
  method: string;
  url: string;
  body: string | null;
}

export interface WireResponse {
  status: number;
  body: unknown;
}

export interface WireLogEntry {
  method: string;
  path: string;
  status: number;
  startMs: number; // performance.now() in the WebView when the page issued it
  ms: number; // until the response was delivered back to the page
  via: 'xhr' | 'fetch';
}

type Responder = (req: WireRequest) => Promise<WireResponse>;

let responder: Responder | null = null;
let waiters: (() => void)[] = [];
export const wireLog: WireLogEntry[] = [];

/** Set (or replace) the function that answers requests. Requests issued before this wait. */
export function setResponder(r: Responder) {
  responder = r;
  const w = waiters;
  waiters = [];
  for (const fn of w) fn();
}

async function answer(req: WireRequest): Promise<WireResponse> {
  if (!responder) await new Promise<void>((res) => waiters.push(res));
  return responder!(req);
}

function pathOnly(url: string) {
  try {
    return new URL(url, 'http://spike.invalid').pathname;
  } catch {
    return url;
  }
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 400: 'Bad Request', 404: 'Not Found', 500: 'Internal Server Error' };

/**
 * Minimal XMLHttpRequest that covers what axios' xhr adapter touches:
 * open/setRequestHeader/send/abort, onloadend/onreadystatechange/onerror/
 * onabort/ontimeout, getAllResponseHeaders, status/statusText/responseText/
 * response/responseURL, withCredentials, timeout, responseType, upload.
 */
class SpikeXHR extends EventTarget {
  static readonly UNSENT = 0;
  static readonly OPENED = 1;
  static readonly HEADERS_RECEIVED = 2;
  static readonly LOADING = 3;
  static readonly DONE = 4;
  readonly UNSENT = 0;
  readonly OPENED = 1;
  readonly HEADERS_RECEIVED = 2;
  readonly LOADING = 3;
  readonly DONE = 4;

  readyState = 0;
  status = 0;
  statusText = '';
  response: unknown = '';
  responseText = '';
  responseType: XMLHttpRequestResponseType = '';
  responseURL = '';
  responseXML = null;
  timeout = 0;
  withCredentials = false;
  upload = new EventTarget();

  onreadystatechange: ((ev: Event) => void) | null = null;
  onload: ((ev: Event) => void) | null = null;
  onloadend: ((ev: Event) => void) | null = null;
  onloadstart: ((ev: Event) => void) | null = null;
  onprogress: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onabort: ((ev: Event) => void) | null = null;
  ontimeout: ((ev: Event) => void) | null = null;

  private _method = 'GET';
  private _url = '';
  private _reqHeaders: Record<string, string> = {};
  private _resHeaders: Record<string, string> = {};
  private _aborted = false;

  open(method: string, url: string | URL) {
    this._method = method.toUpperCase();
    this._url = String(url);
    this._aborted = false;
    this._setState(1);
  }

  setRequestHeader(name: string, value: string) {
    this._reqHeaders[name.toLowerCase()] = value;
  }

  overrideMimeType() {}

  getAllResponseHeaders() {
    return Object.entries(this._resHeaders)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
  }

  getResponseHeader(name: string) {
    return this._resHeaders[name.toLowerCase()] ?? null;
  }

  abort() {
    if (this.readyState === 0 || this.readyState === 4) return;
    this._aborted = true;
    this.readyState = 4;
    this.status = 0;
    this._fire('readystatechange');
    this._fire('abort');
    this._fire('loadend');
  }

  send(body?: Document | XMLHttpRequestBodyInit | null) {
    const startMs = performance.now();
    const req: WireRequest = {
      method: this._method,
      url: this._url,
      body: body == null ? null : typeof body === 'string' ? body : String(body),
    };
    this._fire('loadstart');
    answer(req).then(
      (res) => {
        if (this._aborted) return;
        const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        this.status = res.status;
        this.statusText = STATUS_TEXT[res.status] ?? '';
        this.responseURL = this._url;
        this._resHeaders = { 'content-type': 'application/json' };
        this._setState(2);
        this._setState(3);
        this.responseText = text;
        if (this.responseType === 'json') {
          try {
            this.response = JSON.parse(text);
          } catch {
            this.response = null;
          }
        } else {
          this.response = text;
        }
        wireLog.push({
          method: req.method,
          path: pathOnly(req.url),
          status: res.status,
          startMs: Math.round(startMs),
          ms: Math.round(performance.now() - startMs),
          via: 'xhr',
        });
        this._setState(4);
        this._fire('load');
        this._fire('loadend');
      },
      (err) => {
        if (this._aborted) return;
        console.error('[spike transport] xhr responder failed', err);
        wireLog.push({
          method: req.method,
          path: pathOnly(req.url),
          status: 0,
          startMs: Math.round(startMs),
          ms: Math.round(performance.now() - startMs),
          via: 'xhr',
        });
        this.readyState = 4;
        this.status = 0;
        this._fire('readystatechange');
        this._fire('error');
        this._fire('loadend');
      },
    );
  }

  private _setState(s: number) {
    this.readyState = s;
    this._fire('readystatechange');
  }

  private _fire(type: string) {
    const ev = new Event(type);
    const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof handler === 'function') handler.call(this, ev);
    this.dispatchEvent(ev);
  }
}

let installed = false;

/** Install once per WebView, before the page issues its first request. */
export function installSpikeTransport() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  (window as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = SpikeXHR;

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // The frontend only issues same-origin relative URLs. Absolute http(s) URLs
    // are dev tooling (Metro logs, symbolication) and go to the real network.
    if (/^(https?:)?\/\//i.test(url)) return realFetch(input, init);
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const body = init?.body == null ? null : typeof init.body === 'string' ? init.body : String(init.body);
    const startMs = performance.now();
    const res = await answer({ method, url, body });
    wireLog.push({
      method,
      path: pathOnly(url),
      status: res.status,
      startMs: Math.round(startMs),
      ms: Math.round(performance.now() - startMs),
      via: 'fetch',
    });
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    return new Response(text, {
      status: res.status,
      statusText: STATUS_TEXT[res.status] ?? '',
      headers: { 'content-type': 'application/json' },
    });
  };
}
