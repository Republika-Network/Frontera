/**
 * CTRL-03 — the Frontera web control plane. A server-rendered console that
 * operates a Frontera Host through its operator plane over HTTP only. See
 * `docs/architecture/ADR-CTRL-03-WEB-CONTROL-PLANE.md`.
 */
export { createControlPlaneWebServer, loadControlPlaneWebConfiguration, ControlPlaneWebConfigurationError } from './server.js';
export type { ControlPlaneWebConfiguration, ControlPlaneWebServer, ControlPlaneWebServerOptions } from './server.js';
export { createConsoleApp } from './app.js';
export type { ConsoleAppOptions, ConsoleLogger, ConsoleResponse } from './app.js';
export { createHostClient } from './host-client.js';
export type { HostClient, HostResult } from './host-client.js';
