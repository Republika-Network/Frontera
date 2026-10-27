import { createAuthorityApi, fetchTransport } from './api.js';
import { createController } from './controller.js';
import { mount } from './dom.js';
import { browserPasskeys } from './passkeys.js';
import { render } from './view.js';

/**
 * AUTH-04C — the browser entry point of Frontera Authority.
 *
 * Wires the same-origin gateway client, the operating system's passkey dialog
 * and the view. Nothing here holds a secret: the session is the gateway's
 * HttpOnly cookie, the CSRF token lives only in the controller's memory, and
 * nothing is written to localStorage, sessionStorage, IndexedDB or a URL.
 */

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function boot(): void {
  const root = document.getElementById('app');
  if (root === null) return;
  const controller = createController({
    api: createAuthorityApi(fetchTransport(window.fetch.bind(window))),
    passkeys: browserPasskeys(navigator.credentials ?? undefined, typeof window.PublicKeyCredential === 'function'),
    digest: sha256,
  });
  const draw = (): void => {
    mount(document, root, render(controller.state(), controller, Date.now()));
  };
  controller.subscribe(draw);
  draw();
  // Expiry text stays current while the screen is open; no request is made by this timer.
  window.setInterval(draw, 30_000);
  void controller.start();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
