import assert from 'node:assert/strict';
import { createServer } from 'node:net';

/**
 * CTRL-03 — a faithful browser for a script-free web application.
 *
 * The Frontera console ships no client-side script (its CSP forbids any), so
 * everything a browser does with it is: send GET requests, keep cookies,
 * follow redirects, read HTML, and submit HTML forms as
 * `application/x-www-form-urlencoded` POSTs carrying the page's `Origin`. This
 * helper does exactly that and nothing more — it fills a form from the
 * fields the server rendered (hidden inputs, selected options, textareas),
 * applies the operator's typed values, and submits it. It never constructs a
 * request the rendered page would not produce, unless a test says so
 * explicitly (`forge`), to prove the server refuses it.
 *
 * Every response it sees is kept in `transcript`, so a test can search all of
 * them (headers and bodies) for secrets.
 */

export interface PageView {
  readonly status: number;
  readonly url: string;
  readonly html: string;
  readonly headers: Headers;
}

export interface ParsedForm {
  readonly action: string;
  readonly method: string;
  readonly fields: readonly (readonly [string, string])[];
  readonly html: string;
}

export interface TranscriptEntry {
  readonly method: string;
  readonly url: string;
  readonly requestBody: string;
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match?.[1] === undefined ? undefined : decodeEntities(match[1]);
};

/** Every form on a page, with the values a browser would submit by default. */
export function formsOf(html: string): readonly ParsedForm[] {
  const forms: ParsedForm[] = [];
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    const tag = match[1] ?? '';
    const inner = match[2] ?? '';
    const fields: [string, string][] = [];
    for (const control of inner.matchAll(/<(input|select|textarea)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/g)) {
      const kind = control[1];
      const controlTag = control[2] ?? '';
      const name = attribute(controlTag, 'name');
      if (name === undefined) continue;
      if (kind === 'input') {
        const type = attribute(controlTag, 'type') ?? 'text';
        if ((type === 'checkbox' || type === 'radio') && !/\schecked=""/.test(controlTag)) continue;
        fields.push([name, attribute(controlTag, 'value') ?? '']);
      } else if (kind === 'select') {
        const options = [...(control[3] ?? '').matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)];
        const selected = options.find((option) => /\sselected=""/.test(option[1] ?? '')) ?? options[0];
        fields.push([name, selected === undefined ? '' : (attribute(selected[1] ?? '', 'value') ?? decodeEntities(selected[2] ?? ''))]);
      } else {
        fields.push([name, decodeEntities(control[3] ?? '')]);
      }
    }
    forms.push({ action: attribute(tag, 'action') ?? '', method: (attribute(tag, 'method') ?? 'get').toLowerCase(), fields, html: match[0] });
  }
  return forms;
}

/** Visible text of an HTML fragment (tags removed, entities decoded, whitespace collapsed). */
export function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * The document's referrer policy, as a browser derives it: a `<meta name="referrer">`
 * in the page overrides the response header; with neither, the default is
 * `strict-origin-when-cross-origin`.
 */
export function referrerPolicyOf(page: { readonly html: string; readonly headers: Headers }): string {
  const meta = /<meta name="referrer" content="([^"]+)"/.exec(page.html)?.[1];
  return (meta ?? page.headers.get('referrer-policy') ?? 'strict-origin-when-cross-origin').trim().toLowerCase();
}

/**
 * The `Origin` and `Referer` a browser sends on a form POST (a non-GET
 * navigation, not CORS mode) from a document at `from` with `policy` to
 * `target` — the Fetch standard's "append a request `Origin` header" and the
 * Referrer Policy algorithm. Notably, a `no-referrer` document sends
 * `Origin: null`.
 */
export function navigationHeaders(policy: string, from: string, target: string): Record<string, string> {
  const source = new URL(from);
  const destination = new URL(target);
  const sameOrigin = source.origin === destination.origin;
  const downgrade = source.protocol === 'https:' && destination.protocol !== 'https:';
  let origin: string = source.origin;
  if (policy === 'no-referrer') origin = 'null';
  else if (policy === 'same-origin' && !sameOrigin) origin = 'null';
  else if ((policy === 'no-referrer-when-downgrade' || policy === 'strict-origin' || policy === 'strict-origin-when-cross-origin') && downgrade) origin = 'null';
  const full = `${source.origin}${source.pathname}${source.search}`;
  let referer: string | undefined;
  switch (policy) {
    case 'no-referrer':
      referer = undefined;
      break;
    case 'same-origin':
      referer = sameOrigin ? full : undefined;
      break;
    case 'origin':
      referer = `${source.origin}/`;
      break;
    case 'strict-origin':
      referer = downgrade ? undefined : `${source.origin}/`;
      break;
    case 'origin-when-cross-origin':
      referer = sameOrigin ? full : `${source.origin}/`;
      break;
    case 'unsafe-url':
      referer = full;
      break;
    case 'no-referrer-when-downgrade':
      referer = downgrade ? undefined : full;
      break;
    default:
      referer = sameOrigin ? full : downgrade ? undefined : `${source.origin}/`;
  }
  return { origin, ...(referer !== undefined ? { referer } : {}) };
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

export class Browser {
  readonly cookies = new Map<string, string>();
  readonly transcript: TranscriptEntry[] = [];
  readonly visited: string[] = [];
  /** The last HTML document this browser displayed — the page a forged POST is sent "from". */
  private lastDocument: { readonly url: string; readonly html: string; readonly headers: Headers } | undefined;

  constructor(
    readonly origin: string,
    readonly name = 'browser',
  ) {}

  private cookieHeader(): string | undefined {
    return this.cookies.size === 0 ? undefined : [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  private absorbCookies(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const index = (pair ?? '').indexOf('=');
      const key = (pair ?? '').slice(0, index).trim();
      const value = (pair ?? '').slice(index + 1).trim();
      if (attributes.some((entry) => /^\s*max-age=0\s*$/i.test(entry)) || value === '') this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
  }

  private async send(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; text: string; url: string }> {
    const url = new URL(path, this.origin).toString();
    const cookie = this.cookieHeader();
    const response = await fetch(url, {
      method,
      redirect: 'manual',
      headers: { ...(cookie !== undefined ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      ...(body !== undefined ? { body } : {}),
    });
    const text = await response.text();
    this.absorbCookies(response.headers);
    this.visited.push(url);
    this.transcript.push({ method, url, requestBody: body ?? '', status: response.status, headers: [...response.headers.entries()], body: text });
    return { status: response.status, headers: response.headers, text, url };
  }

  /** GET a page, following redirects as a browser does. */
  async get(path: string): Promise<PageView> {
    let current = path;
    for (let hop = 0; hop < 5; hop += 1) {
      const response = await this.send('GET', current);
      if (response.status === 303 || response.status === 302 || response.status === 301) {
        const location = response.headers.get('location');
        assert.ok(location !== null, 'a redirect carries a location');
        current = location;
        continue;
      }
      const view = { status: response.status, url: response.url, html: response.text, headers: response.headers };
      this.lastDocument = view;
      return view;
    }
    throw new Error('too many redirects');
  }

  /** The headers this browser would attach to a form POST from `page` (or its last document) to `action`. */
  headersFor(action: string, page?: { readonly url: string; readonly html: string; readonly headers: Headers }): Record<string, string> {
    const from = page ?? this.lastDocument;
    if (from === undefined) return {};
    return navigationHeaders(referrerPolicyOf(from), from.url, new URL(action, this.origin).toString());
  }

  /**
   * Submits a form the page rendered. `values` are what the operator types or
   * selects (they replace the rendered value of that field, or add it).
   */
  async submit(page: PageView, select: (form: ParsedForm) => boolean, values: Readonly<Record<string, string>> = {}): Promise<PageView> {
    const form = formsOf(page.html).find(select);
    assert.ok(form !== undefined, `the page ${page.url} renders the expected form`);
    assert.equal(form.method, 'post', 'operations are POST forms');
    const fields = new URLSearchParams();
    const overridden = new Set<string>();
    for (const [name, value] of form.fields) {
      if (Object.prototype.hasOwnProperty.call(values, name)) {
        if (!overridden.has(name)) fields.append(name, values[name] ?? '');
        overridden.add(name);
      } else {
        fields.append(name, value);
      }
    }
    for (const [name, value] of Object.entries(values)) if (!overridden.has(name)) fields.append(name, value);
    return this.post(form.action, fields.toString(), this.headersFor(form.action, page));
  }

  /**
   * A POST with the given body — used to prove the server refuses what no
   * rendered page offers. By default it carries what this browser would send
   * from its last document (Origin / Referer per that document's referrer
   * policy); a test may pass other headers to forge a cross-site request.
   */
  async post(path: string, body: string, headers: Record<string, string> = this.headersFor(path)): Promise<PageView> {
    const response = await this.send('POST', path, body, headers);
    if (response.status === 303) {
      const location = response.headers.get('location');
      assert.ok(location !== null);
      return this.get(location);
    }
    const view = { status: response.status, url: response.url, html: response.text, headers: response.headers };
    this.lastDocument = view;
    return view;
  }

  async signIn(credential: string): Promise<PageView> {
    const login = await this.get('/login');
    return this.submit(login, (form) => form.action === '/login', { credential });
  }

  /** The value of a hidden field on the page's first form that has one. */
  static hidden(page: PageView, name: string): string {
    for (const form of formsOf(page.html)) {
      const field = form.fields.find(([field]) => field === name);
      if (field !== undefined) return field[1];
    }
    throw new Error(`no form field '${name}' on ${page.url}`);
  }
}
