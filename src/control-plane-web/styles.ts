/**
 * CTRL-03 — the console's one stylesheet, served same-origin at
 * `/assets/console.css` (the CSP allows styles from `'self'` only). Dense,
 * high-contrast, keyboard-visible focus; status is never conveyed by colour
 * alone (every status also carries text and a symbol).
 */
export const CONSOLE_CSS = `
:root { color-scheme: light; --fg: #14171a; --muted: #5b6470; --line: #d5d9de; --bg: #f6f7f9; --panel: #fff; --accent: #0b4f9c; --ok: #0f6b3a; --stop: #a3201a; --warn: #8a5a00; }
* { box-sizing: border-box; }
html { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); }
body { margin: 0; }
a { color: var(--accent); }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid #f0a500; outline-offset: 2px; }
code, .id, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
.id { word-break: break-all; }
.topbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 24px; padding: 10px 20px; background: #10243f; color: #fff; }
.topbar a, .topbar .id { color: #fff; }
.brand { font-weight: 700; font-size: 1.15rem; text-decoration: none; }
.brand__product { font-weight: 400; opacity: 0.85; }
.context { display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: center; }
.role { opacity: 0.85; }
.nav { background: #fff; border-bottom: 1px solid var(--line); }
.nav ul { display: flex; flex-wrap: wrap; margin: 0; padding: 0 12px; list-style: none; }
.nav__item { display: block; padding: 10px 12px; text-decoration: none; color: var(--fg); border-bottom: 3px solid transparent; }
.nav__item--active { border-bottom-color: var(--accent); font-weight: 600; }
.main { max-width: 1400px; margin: 0 auto; padding: 16px 20px 40px; }
h1 { font-size: 1.45rem; margin: 4px 0 14px; }
h2 { font-size: 1.1rem; margin: 0; }
h3 { font-size: 0.98rem; margin: 14px 0 6px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 14px 16px; margin: 0 0 14px; }
.panel--narrow { max-width: 640px; }
.panel__header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.table { width: 100%; border-collapse: collapse; margin: 6px 0; }
.table caption { text-align: left; color: var(--muted); padding: 4px 0; }
.table th, .table td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
.table th { background: #eef1f4; font-weight: 600; }
.row--incomplete { background: #fff7e6; }
.kv { display: grid; grid-template-columns: minmax(160px, max-content) 1fr; gap: 4px 16px; margin: 0; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; }
.inline-list { display: inline; margin: 0; padding: 0; list-style: none; }
.inline-list li { display: inline; }
.inline-list li + li::before { content: ", "; }
.status { font-weight: 600; white-space: nowrap; }
.status--ok { color: var(--ok); }
.status--stop { color: var(--stop); }
.status--neutral { color: var(--muted); }
.muted { color: var(--muted); }
.missing { color: var(--warn); font-style: italic; }
.emphasis { font-weight: 600; }
.help { color: var(--muted); margin: 4px 0 8px; }
.notice { border: 1px solid var(--line); border-left-width: 6px; border-radius: 6px; padding: 10px 14px; margin: 0 0 14px; background: #fff; }
.notice--info { border-left-color: var(--accent); }
.notice--success { border-left-color: var(--ok); }
.notice--warning { border-left-color: var(--warn); background: #fffaf0; }
.notice--danger { border-left-color: var(--stop); background: #fff5f5; }
.notice__title { font-size: 1rem; margin-bottom: 4px; }
.flash { background: #eef6ff; border: 1px solid #b9d6f5; border-radius: 6px; padding: 8px 12px; }
.aoc-empty-state { color: var(--muted); font-style: italic; }
.aoc-error-state__code { font-family: ui-monospace, monospace; }
.form { margin: 8px 0; }
.form--inline { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin: 8px 0; }
.inline-form { display: inline; margin: 0; }
fieldset { border: 1px solid var(--line); border-radius: 6px; margin: 0 0 12px; padding: 10px 14px; }
legend { font-weight: 600; padding: 0 4px; }
.field { display: flex; flex-direction: column; gap: 3px; margin: 0 0 10px; min-width: 180px; }
.field--check { flex-direction: row; align-items: center; gap: 8px; }
.field--error .input { border-color: var(--stop); }
.field-row { display: flex; flex-wrap: wrap; gap: 10px; }
.field-error { color: var(--stop); margin: 2px 0; font-weight: 600; }
.required { color: var(--muted); font-weight: 400; }
.input { font: inherit; padding: 5px 7px; border: 1px solid #9aa3ad; border-radius: 4px; background: #fff; color: var(--fg); max-width: 100%; }
.input--fixed { background: #eef1f4; }
textarea.input { min-width: 260px; }
.form__actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
.button { font: inherit; display: inline-block; padding: 6px 12px; border: 1px solid #6b7682; border-radius: 4px; background: #fff; color: var(--fg); text-decoration: none; cursor: pointer; }
.button--primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.button--danger { background: var(--stop); border-color: var(--stop); color: #fff; }
.button--quiet { background: transparent; border-color: transparent; color: inherit; text-decoration: underline; }
.topbar .button--quiet { color: #fff; }
.action-link { font-weight: 600; white-space: nowrap; }
.action-group { display: inline-flex; flex-wrap: wrap; gap: 6px 14px; }
.action-list { margin: 0; padding-left: 18px; }
.secret { white-space: pre-wrap; word-break: break-all; background: #fffbe6; border: 2px dashed var(--warn); padding: 12px; font-size: 1rem; user-select: all; }
.stages { margin: 0; padding-left: 20px; }
.stage--done { color: var(--ok); }
.stage--open { color: var(--muted); }
.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px 20px; }
.json { white-space: pre-wrap; word-break: break-all; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.tabs { margin: 0 0 10px; }
.tab { padding: 4px 10px; border-radius: 4px; }
.tab--active { background: var(--line); font-weight: 600; }
.plain-list { margin: 0; padding-left: 16px; }
.quorum { font-variant-numeric: tabular-nums; font-weight: 600; }
.canonical { white-space: pre-wrap; word-break: break-all; font-size: 0.85em; }
.field-row__label { min-width: 160px; }
.footer { max-width: 1400px; margin: 0 auto; padding: 0 20px 30px; color: var(--muted); font-size: 0.9em; }
@media (max-width: 720px) { .kv { grid-template-columns: 1fr; } .table { display: block; overflow-x: auto; } .main { padding: 12px; } }
`;
