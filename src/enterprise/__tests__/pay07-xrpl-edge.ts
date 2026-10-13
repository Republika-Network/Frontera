import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { PaymentRail } from '../../features/payment-runtime/index.js';
import type { MppMethodNormalizer } from '../../features/payment-runtime/protocols/mpp/index.js';
import { createXrplRlusdRail, type XrplRlusdRailConfiguration } from '../../features/payment-runtime/rails/xrpl/index.js';
import { RLUSD_ASSET, TREASURY, VENDOR, testClock, testConfiguration } from '../../features/payment-runtime/rails/xrpl/tests/xrpl-test-fixtures.js';
import { createExternalXrplSigner, type ExternalXrplSignerPin } from '../xrpl-payment-rail/external-xrpl-signer.js';
import { startReferenceXrplSigner } from '../xrpl-payment-rail/reference/reference-xrpl-signer-service.js';
import { createHttpExternalXrplSignerTransport } from '../xrpl-payment-rail/signer-http-transport.js';
import { createSqliteXrplSubmissionInterlock, type DurableXrplSubmissionInterlock } from '../xrpl-payment-rail/sqlite-xrpl-submission-interlock.js';
import { createXrplFinalityAuthority, readOnlyXrplFinalityLedger } from '../xrpl-payment-rail/xrpl-finality-authority.js';
import { createXrplResolutionAuthority, readOnlyXrplLedger } from '../xrpl-payment-rail/xrpl-resolution-authority.js';
import { boundaryFor } from './core07-freshness-fixture.js';
import { SIGNER_ID, SIGNER_TOKEN, SIMULATED_RESTART_QUARANTINE, createLedgerSimulator, type LedgerSimulator } from './pay03-xrpl-fixture.js';
import { BUSINESS_REFERENCE, GOVERNED_ACCOUNT, type OpenedPaymentRailEdge, type PaymentRailEdge } from './pay07-governed-payment-world.js';

/**
 * PAY-07 — the XRPL / RLUSD rail edge, composed as PAY-03 composes it in
 * production: PAY-02's real rail (build, network check, preparation, signature
 * verification, the one submission, finality mapping), the external
 * customer-controlled transaction signer (`frontera.external-xrpl-transaction-signer.v1`,
 * the reference signer process over loopback HTTP, identity pinned, blob
 * verified locally — the world holds no key), the durable submission interlock
 * anchored at the world's CORE-07 witness, the read-only P12 resolution
 * authority and the read-only PAY-05 finality authority. The ledger is PAY-03's
 * deterministic simulator (rippled API v2 answers, every submission counted).
 *
 * Everything XRPL-specific stops here. The shared world receives a
 * `PaymentRail`, two read-only authorities and generic capabilities.
 */

const PIN: ExternalXrplSignerPin = { signerId: SIGNER_ID, accounts: [{ address: TREASURY.classicAddress, signingPublicKey: TREASURY.publicKey }] };
const CONFIGURATION: XrplRlusdRailConfiguration = testConfiguration({ sourceAccounts: [{ accountId: GOVERNED_ACCOUNT, address: TREASURY.classicAddress }], finalityTimeoutMs: 5_000, pollIntervalMs: 1_000 });
/** Trusted directory: the merchant this deployment pays on XRPL, and where. */
const MERCHANT = 'merchant-xrpl-7';
const DESTINATION = Object.freeze({ kind: 'xrpl-tagged-account', reference: `${VENDOR.classicAddress}:4471` });

/** Trusted host composition: the merchant's `ledgerpay` MPP method quotes RLUSD as decimal text; the host maps it and prefers the RLUSD rail. */
const LEDGERPAY: MppMethodNormalizer = {
  methodId: 'ledgerpay',
  intent: 'charge',
  rail: CONFIGURATION.railId,
  normalize(challenge) {
    const amount = challenge.decodedRequest['amount'];
    const recipient = challenge.decodedRequest['recipient'];
    if (typeof amount !== 'string' || challenge.decodedRequest['currency'] !== 'rlusd') return undefined;
    return { amount: { value: amount, unit: RLUSD_ASSET }, ...(typeof recipient === 'string' ? { merchantReference: recipient } : {}), reference: BUSINESS_REFERENCE };
  },
};

const freshnessCode = (error: unknown): string => (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'UNCODED');

export const XRPL_EDGE: PaymentRailEdge = Object.freeze<PaymentRailEdge>({
  implementationId: CONFIGURATION.railId,
  railId: CONFIGURATION.railId,
  asset: { assetId: RLUSD_ASSET, scale: 15 },
  // The logical bound: a ceiling of 1000 RLUSD; 2.5 % of it is within, 1.00001 × of it is over — in RLUSD's own exact unit.
  economics: { ceiling: { value: '1000', unit: RLUSD_ASSET }, withinCeiling: { value: '25', unit: RLUSD_ASSET }, overCeiling: { value: '1000.01', unit: RLUSD_ASSET } },
  lifetime: '100000',
  mppMethod: LEDGERPAY,
  mppRequest: (amount, merchantReference) => ({ amount: amount.value, currency: 'rlusd', recipient: merchantReference }),

  async open({ directory, witness, organizationId }): Promise<OpenedPaymentRailEdge> {
    const interlockPath = join(directory, 'xrpl-submission-interlock.sqlite');
    const backupPath = join(directory, 'xrpl-submission-interlock.before-payment.sqlite');
    const ledger: LedgerSimulator = createLedgerSimulator();
    const signerProcess = await startReferenceXrplSigner({ signerId: SIGNER_ID, seed: TREASURY.seed!, credential: SIGNER_TOKEN });
    const openInterlock = async (): Promise<DurableXrplSubmissionInterlock> =>
      createSqliteXrplSubmissionInterlock(interlockPath, { scope: { railId: CONFIGURATION.railId, networkId: CONFIGURATION.networkId }, now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, organizationId) } });

    // A backup of the interlock taken before any payment: the stale copy a rollback would restore.
    let interlock = await openInterlock();
    await interlock.close();
    copyFileSync(interlockPath, backupPath);
    interlock = await openInterlock();
    let open = true;

    const railOver = async (store: DurableXrplSubmissionInterlock): Promise<PaymentRail> => {
      const signer = createExternalXrplSigner({ transport: createHttpExternalXrplSignerTransport({ endpoint: `http://127.0.0.1:${signerProcess.port}`, credential: SIGNER_TOKEN }), pin: PIN, timeoutMs: 2_000, probeIntervalMs: 0 });
      const rail = createXrplRlusdRail({ configuration: CONFIGURATION, client: ledger, signers: signer.signers, interlock: store, ...testClock() });
      await rail.readiness();
      // PAY-03's restart quarantine: the simulated ledgers that close before a (re)started rail may submit.
      ledger.index += SIMULATED_RESTART_QUARANTINE;
      return rail;
    };
    let rail = await railOver(interlock);
    const delegate: PaymentRail = { railId: CONFIGURATION.railId, execute: (request) => rail.execute(request) };

    const onlySubmission = (): string => {
      const [hash, ...more] = [...ledger.transactions.keys()];
      if (hash === undefined || more.length > 0) throw new Error('pay07-xrpl: expected exactly one submitted transaction');
      return hash;
    };

    return {
      rail: delegate,
      preparePayee: async () => ({ merchantReference: MERCHANT, destination: DESTINATION }),
      behave(behaviour) {
        ledger.submitMode = behaviour === 'uncertain' ? 'lost-after-send' : 'accept';
        ledger.nextOutcome = behaviour === 'complete' ? 'success' : behaviour === 'fail' ? 'tec' : 'pending';
      },
      effects: () => ledger.calls.submit,
      async resolveExternally(outcome) {
        ledger.validate(onlySubmission(), outcome === 'completed' ? 'success' : 'tec');
      },
      resolutionAuthority: () => createXrplResolutionAuthority({ configuration: CONFIGURATION, ledger: readOnlyXrplLedger(ledger), interlock }),
      finalityAuthority: () => createXrplFinalityAuthority({ configuration: CONFIGURATION, ledger: readOnlyXrplFinalityLedger(ledger), interlock }),
      async restart() {
        await interlock.close();
        interlock = await openInterlock();
        rail = await railOver(interlock);
      },
      async rollback() {
        await interlock.close();
        open = false;
        for (const suffix of ['-wal', '-shm']) rmSync(`${interlockPath}${suffix}`, { force: true });
        copyFileSync(backupPath, interlockPath);
        try {
          interlock = await openInterlock();
          open = true;
          return { refused: false };
        } catch (error) {
          return { refused: true, code: freshnessCode(error) };
        }
      },
      async close() {
        if (open) await interlock.close().catch(() => undefined);
        await signerProcess.close();
      },
    };
  },
});
