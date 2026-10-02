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
      return { status: response.status, url: response.url, html: response.text, headers: response.headers };
    }
    throw new Error('too many redirects');
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
    return this.post(form.action, fields.toString());
  }

  /** A POST exactly as given — used to prove the server refuses what no rendered page offers. */
  async post(path: string, body: string, headers: Record<string, string> = { origin: this.origin }): Promise<PageView> {
    const response = await this.send('POST', path, body, headers);
    if (response.status === 303) {
      const location = response.headers.get('location');
      assert.ok(location !== null);
      return this.get(location);
    }
    return { status: response.status, url: response.url, html: response.text, headers: response.headers };
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
