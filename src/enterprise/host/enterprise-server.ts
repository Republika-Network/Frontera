import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createEnterpriseRequestListener } from '../adapters/node-http-adapter.js';
import { createEnterprise, type AocEnterprise, type CreateEnterpriseOptions } from '../composition/composition-root.js';

export interface EnterpriseServer {
  readonly enterprise: AocEnterprise;
  readonly server: Server;
  listen(): Promise<{ readonly port: number; readonly host: string }>;
  close(): Promise<void>;
}

/**
 * Binds a composed `AocEnterprise` (`composition/composition-root.ts`) to a
 * plain `node:http` server -- no web framework dependency, consistent with
 * the rest of this package. The HTTP server consumes only the stable
 * `AocEnterprise` interface -- it has no visibility into how the Kernel,
 * persistence, or providers were composed.
 *
 * This is the embedding-level server factory. The process an operator starts
 * (`npm run start:enterprise`) does not call it directly: it calls
 * `bootEnterpriseHost()` (`host/enterprise-host.ts`), which validates the
 * deployment's secure profile, composes the governed-action spine from
 * configuration, and then delegates here.
 */
export async function createEnterpriseServer(options: CreateEnterpriseOptions = {}): Promise<EnterpriseServer> {
  const enterprise = await createEnterprise(options);
  const server = createServer(createEnterpriseRequestListener(enterprise));
  let closing: Promise<void> | undefined;

  return {
    enterprise,
    server,
    listen() {
      return new Promise((resolvePromise, rejectPromise) => {
        // A bind failure (port in use, address unavailable) rejects instead of
        // surfacing as an unhandled 'error' event; the caller decides whether to
        // close the composed Enterprise.
        const onError = (error: Error): void => rejectPromise(error);
        server.once('error', onError);
        server.listen(enterprise.configuration.http.port, enterprise.configuration.http.host, () => {
          server.off('error', onError);
          enterprise.logger.info('enterprise.host.listening', {});
          // Read back the OS-assigned port (relevant when `http.port` is configured as
          // 0, e.g. in tests) rather than trusting the configured value blindly.
          const address = server.address() as AddressInfo;
          resolvePromise({ port: address.port, host: enterprise.configuration.http.host });
        });
      });
    },
    close() {
      // Idempotent, and safe before `listen()`: a server that never bound still
      // owns a composed Enterprise whose stores must be closed.
      closing ??= (async () => {
        if (server.listening) {
          await new Promise<void>((resolvePromise, rejectPromise) => {
            server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
            // Stop accepting first, then drop idle keep-alive sockets so close
            // does not wait on a client that will never send again.
            server.closeIdleConnections();
          });
        }
        await enterprise.close();
      })();
      return closing;
    },
  };
}
