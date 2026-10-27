import { ALLOWED_ATTRIBUTES, type ActionHandler, type InputHandler, type VElement, type VNode } from './vnode.js';

/**
 * AUTH-04C — mounts the virtual tree into the page.
 *
 * A small reconciler: same tag at the same position is updated in place (so a
 * focused input keeps its caret while the human types), anything else is
 * replaced. Text is set with `textContent` / text nodes and attributes with
 * `setAttribute` from the closed allowlist — never `innerHTML`, never an inline
 * handler. When the screen changes, focus moves to the new screen's heading so
 * VoiceOver announces where the human is.
 */

interface Handlers {
  onClick?: ActionHandler;
  onSubmit?: ActionHandler;
  onInput?: InputHandler;
}

const handlers = new WeakMap<Element, Handlers>();

function wire(element: Element): void {
  element.addEventListener('click', (event) => {
    const handler = handlers.get(element)?.onClick;
    if (handler === undefined) return;
    event.preventDefault();
    if (element instanceof HTMLButtonElement && element.disabled) return;
    handler();
  });
  element.addEventListener('submit', (event) => {
    event.preventDefault();
    handlers.get(element)?.onSubmit?.();
  });
  element.addEventListener('input', () => {
    const handler = handlers.get(element)?.onInput;
    if (handler !== undefined && element instanceof HTMLInputElement) handler(element.value);
  });
}

function applyAttributes(element: Element, vnode: VElement): void {
  for (const name of ALLOWED_ATTRIBUTES) {
    const value = vnode.attributes[name];
    if (name === 'value' && element instanceof HTMLInputElement) {
      // The property, not the attribute, and only when it differs: the caret stays where the human left it.
      if (element.value !== (value ?? '')) element.value = value ?? '';
      continue;
    }
    if (value === undefined) {
      if (element.hasAttribute(name)) element.removeAttribute(name);
    } else if (element.getAttribute(name) !== value) {
      element.setAttribute(name, value);
    }
  }
  handlers.set(element, {
    ...(vnode.onClick !== undefined ? { onClick: vnode.onClick } : {}),
    ...(vnode.onSubmit !== undefined ? { onSubmit: vnode.onSubmit } : {}),
    ...(vnode.onInput !== undefined ? { onInput: vnode.onInput } : {}),
  });
}

function create(document: Document, vnode: VNode): Node {
  if (vnode.kind === 'text') return document.createTextNode(vnode.text);
  const element = document.createElement(vnode.tag);
  wire(element);
  applyAttributes(element, vnode);
  for (const child of vnode.children) element.appendChild(create(document, child));
  return element;
}

function patch(document: Document, parent: Node, existing: ChildNode | null, vnode: VNode): void {
  if (existing === null) {
    parent.appendChild(create(document, vnode));
    return;
  }
  if (vnode.kind === 'text') {
    if (existing.nodeType === 3) {
      if (existing.textContent !== vnode.text) existing.textContent = vnode.text;
    } else {
      parent.replaceChild(create(document, vnode), existing);
    }
    return;
  }
  if (!(existing instanceof Element) || existing.tagName.toLowerCase() !== vnode.tag || !handlers.has(existing)) {
    parent.replaceChild(create(document, vnode), existing);
    return;
  }
  applyAttributes(existing, vnode);
  patchChildren(document, existing, vnode.children);
}

function patchChildren(document: Document, parent: Element, children: readonly VNode[]): void {
  const current = [...parent.childNodes];
  children.forEach((child, index) => patch(document, parent, current[index] ?? null, child));
  for (const extra of current.slice(children.length)) parent.removeChild(extra);
}

/** Renders `vnode` into `root`. Returns whether the screen changed (focus was moved). */
export function mount(document: Document, root: Element, vnode: VElement): boolean {
  const before = root.firstElementChild?.getAttribute('data-state') ?? null;
  patchChildren(document, root, [vnode]);
  const after = root.firstElementChild?.getAttribute('data-state') ?? null;
  if (before !== after) {
    const target = root.querySelector('[data-focus="screen"]');
    if (target instanceof HTMLElement) target.focus({ preventScroll: false });
    return true;
  }
  return false;
}
