/**
 * AUTH-04C — a minimal virtual-node model for the Authority web client.
 *
 * The view is a pure function of state that returns these nodes; `dom.ts`
 * mounts them in the browser and the tests read them directly. Text is always
 * text: there is no way to express raw HTML, so an action name, a parameter or
 * a server message can never become markup or script. Attributes come from a
 * closed allowlist (no `on*`, `style`, `href`, `src`, `srcdoc` or `innerHTML`).
 */

export const ALLOWED_ATTRIBUTES = [
  'id',
  'class',
  'role',
  'type',
  'name',
  'value',
  'for',
  'autocomplete',
  'autocapitalize',
  'spellcheck',
  'inputmode',
  'enterkeyhint',
  'maxlength',
  'tabindex',
  'disabled',
  'hidden',
  'open',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-live',
  'aria-busy',
  'aria-current',
  'aria-invalid',
  'aria-expanded',
  'aria-controls',
  'data-tone',
  'data-focus',
  'data-state',
  'datetime',
] as const;

export type AllowedAttribute = (typeof ALLOWED_ATTRIBUTES)[number];

export type ActionHandler = () => void;
export type InputHandler = (value: string) => void;

export interface VElement {
  readonly kind: 'element';
  readonly tag: string;
  readonly attributes: Readonly<Partial<Record<AllowedAttribute, string>>>;
  readonly onClick?: ActionHandler;
  readonly onSubmit?: ActionHandler;
  readonly onInput?: InputHandler;
  readonly children: readonly VNode[];
}

export interface VText {
  readonly kind: 'text';
  readonly text: string;
}

export type VNode = VElement | VText;

export const ALLOWED_TAGS = [
  'div',
  'main',
  'header',
  'footer',
  'nav',
  'section',
  'article',
  'aside',
  'h1',
  'h2',
  'h3',
  'p',
  'span',
  'strong',
  'em',
  'small',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'form',
  'label',
  'input',
  'button',
  'details',
  'summary',
  'pre',
  'code',
  'time',
] as const;

export type AllowedTag = (typeof ALLOWED_TAGS)[number];

export interface ElementProps extends Partial<Record<AllowedAttribute, string | boolean | undefined>> {
  readonly onClick?: ActionHandler;
  readonly onSubmit?: ActionHandler;
  readonly onInput?: InputHandler;
}

export type Child = VNode | string | false | null | undefined | readonly Child[];

function flatten(children: readonly Child[], into: VNode[]): VNode[] {
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    if (typeof child === 'string') into.push({ kind: 'text', text: child });
    else if (Array.isArray(child)) flatten(child, into);
    else into.push(child as VNode);
  }
  return into;
}

/** Builds an element. Boolean attributes render as present (`true`) or absent (`false`/`undefined`). */
export function h(tag: AllowedTag, props: ElementProps = {}, ...children: Child[]): VElement {
  const attributes: Partial<Record<AllowedAttribute, string>> = {};
  for (const name of ALLOWED_ATTRIBUTES) {
    const value = props[name];
    if (value === undefined || value === false) continue;
    attributes[name] = value === true ? '' : value;
  }
  return {
    kind: 'element',
    tag,
    attributes,
    ...(props.onClick !== undefined ? { onClick: props.onClick } : {}),
    ...(props.onSubmit !== undefined ? { onSubmit: props.onSubmit } : {}),
    ...(props.onInput !== undefined ? { onInput: props.onInput } : {}),
    children: flatten(children, []),
  };
}

/** Every text in a tree, in order — for tests and accessible-name checks. */
export function textOf(node: VNode): string {
  return node.kind === 'text' ? node.text : node.children.map(textOf).join('');
}

/** Depth-first search for elements matching a predicate. */
export function findAll(node: VNode, predicate: (element: VElement) => boolean): VElement[] {
  if (node.kind === 'text') return [];
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => findAll(child, predicate))];
}
