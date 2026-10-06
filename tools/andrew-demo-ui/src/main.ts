import { isMainnetEndpoint } from '../../andrew-demo-harness/dist/configuration.js';
import { createLedgerPorts } from '../../andrew-demo-harness/dist/live-wiring.js';
import { DemoController } from './controller.js';
import type { DemoMode } from './dto.js';
import { DEMO_UI_DEFAULT_PORT, startDemoServer, type DemoServer } from './server.js';

/**
 * ANDREW-DEMO-UI-01 — start the visual demo.
 *
 *   REHEARSAL (default): scripted ledger, ephemeral in-memory keys, never reads
 *   the secrets file, never reaches any network.
 *   LIVE (`--live`): the P0-11 configuration and the real XRPL Testnet ports;
 *   secrets stay in this process. Mainnet is refused before anything starts.
 */

export interface StartOptions {
  readonly mode: DemoMode;
  /** Non-secret overrides, forwarded by the entry script. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly port?: number;
  readonly write: (line: string) => void;
}

export interface StartedDemo {
  readonly controller: DemoController;
  readonly server: DemoServer;
  stop(): Promise<void>;
}

export async function startAndrewDemoUi(options: StartOptions): Promise<StartedDemo | undefined> {
  const endpoint = options.environment['FRONTERA_XRPL_TESTNET_ENDPOINT'];
  if (options.mode === 'live' && endpoint !== undefined && isMainnetEndpoint(endpoint)) {
    options.write('Refused: the XRPL endpoint is a Mainnet server. This demo is XRPL Testnet only.');
    return undefined;
  }
  const controller = new DemoController({ mode: options.mode, environment: options.environment, ...(options.mode === 'live' ? { ports: createLedgerPorts() } : {}) });
  const server = await startDemoServer(controller, { port: options.port ?? DEMO_UI_DEFAULT_PORT });
  options.write('');
  options.write(`FRONTERA — Andrew / LUMX visual demo — ${options.mode === 'live' ? 'LIVE • XRPL TESTNET' : 'REHEARSAL — NO XRPL TRANSACTION'}`);
  options.write(`Open ${server.url}  (bound to 127.0.0.1 only)`);
  if (options.mode === 'live') options.write('Live payments happen only on an explicit EXECUTE click in the browser, after a READY preflight.');
  options.write('Ctrl+C to stop.');
  return {
    controller,
    server,
    async stop() {
      await controller.close();
      await server.close();
    },
  };
}
