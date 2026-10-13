import {
  STRIPE_API_VERSION,
  StripeRequestNotSentError,
  createStripeRailConfiguration,
  type StripeConfirmInstruction,
  type StripeCreateInstruction,
  type StripePaymentBinding,
  type StripePaymentInterlock,
  type StripePaymentPort,
  type StripePaymentReservation,
  type StripePaymentReservationInput,
  type StripePaymentReservationRecord,
  type StripeRailConfiguration,
  type StripeRailConfigurationInput,
} from '../index.js';

/**
 * PAY-09 — the deterministic Stripe simulator and test fixtures.
 *
 * The simulator stands **below the external Stripe port only** — it never
 * stands in for the generic `PaymentRail`: the real rail, the real
 * classification and (in enterprise tests) the real durable interlock, P12
 * flow and PAY-05 service run above it. It answers with the same neutral
 * PaymentIntent view the HTTPS adapter builds from Stripe's JSON, and models
 * the semantics PAY-09 relies on:
 *
 * - `create` makes a PaymentIntent in `requires_confirmation` (confirm=false,
 *   a PaymentMethod supplied) and never charges;
 * - `confirm` is the only call that can move money (`calls.confirmReceived`
 *   counts the confirmations that reached "Stripe"; a `not-sent` failure is
 *   counted separately and changes nothing);
 * - idempotency: the same key with the same parameters replays the first
 *   answer; the same key with other parameters is refused; `pruneIdempotency()`
 *   models Stripe dropping keys after their retention window;
 * - a failed attempt leaves `requires_payment_method` with a payment error
 *   and the PaymentMethod detached, as Stripe does;
 * - an object lives in one account: `createSimulatedStripe({ mirrorOf })`
 *   builds another account that answers about the SAME object ids (the
 *   account-substitution adversary).
 *
 * Test-only. Never imported by production code.
 */

export const PLATFORM_ACCOUNT = 'acct_1FronteraPlatform';
export const OTHER_PLATFORM_ACCOUNT = 'acct_1SomeoneElsesPlatform';
export const CONNECTED_ACCOUNT = 'acct_1ConnectedMerchant';
export const OTHER_CONNECTED_ACCOUNT = 'acct_1OtherMerchant';
export const UNCONFIGURED_CONNECTED_ACCOUNT = 'acct_1NotConfigured';
export const TEST_CUSTOMER = 'cus_TestAgentFunding';
/** An official Stripe test PaymentMethod id ("pm_card_visa: Visa, succeeds") — never a card number. */
export const TEST_PAYMENT_METHOD = 'pm_card_visa';
export const USD_ASSET = 'USD';
export const GOVERNED_ACCOUNT = 'treasury-operating';

export function testRailConfiguration(overrides: Partial<StripeRailConfigurationInput> = {}): StripeRailConfiguration {
  return createStripeRailConfiguration({
    mode: 'test',
    apiVersion: STRIPE_API_VERSION,
    platformAccountId: PLATFORM_ACCOUNT,
    currency: 'usd',
    asset: { paymentAsset: USD_ASSET, scale: 2 },
    captureMethod: 'automatic',
    fundingSources: [{ accountId: GOVERNED_ACCOUNT, customerId: TEST_CUSTOMER, paymentMethodId: TEST_PAYMENT_METHOD }],
    connectedAccounts: [CONNECTED_ACCOUNT, OTHER_CONNECTED_ACCOUNT],
    requestTimeoutMs: 1_000,
    confirmTimeoutMs: 2_000,
    ...overrides,
  });
}

/** What the next confirmation does. */
export type SimulatedConfirmBehaviour =
  | 'succeed'
  | 'decline'
  | 'authentication-required'
  | 'processing'
  | 'requires-action'
  | 'requires-capture'
  /** Stripe charges, then the response is lost (a reset after the request was read). */
  | 'succeed-response-lost'
  /** Stripe starts processing, then the response is lost. */
  | 'processing-response-lost'
  /** The TCP connection never opened: nothing reached Stripe. */
  | 'not-sent'
  /** The adapter never answers (the rail's own deadline fires). Stripe charged. */
  | 'succeed-never-answers';

export type SimulatedCreateBehaviour = 'ok' | 'fail' | 'response-lost' | 'wrong-amount';

interface SimulatedIntent {
  id: string;
  status: string;
  livemode: boolean;
  amountCents: bigint;
  amountReceivedCents: bigint;
  currency: string;
  customerId: string | null;
  paymentMethodId: string | null;
  destinationAccountId: string | null;
  transferAmountCents: bigint | null;
  onBehalfOf: string | null;
  applicationFeeCents: bigint | null;
  captureMethod: string;
  confirmationMethod: string;
  executionId: string | null;
  railId: string | null;
  lastPaymentError: string | null;
  latestChargeId: string | null;
}

interface SharedLedger {
  readonly intents: Map<string, SimulatedIntent>;
  readonly idempotency: Map<string, { readonly parameters: string; readonly result: string }>;
  sequence: number;
}

export interface SimulatedStripe extends StripePaymentPort {
  readonly platformAccountId: string;
  readonly calls: { create: number; confirmAttempted: number; confirmReceived: number; retrieve: number; account: number };
  readonly instructions: { readonly create: StripeCreateInstruction[]; readonly confirm: StripeConfirmInstruction[] };
  createBehaviour: SimulatedCreateBehaviour;
  confirmBehaviour: SimulatedConfirmBehaviour;
  /** `undefined` → answer normally; `'unavailable'` → every read throws; `'live'` → the credential reads as live mode. */
  readMode: 'normal' | 'unavailable' | 'live';
  intent(id: string): Readonly<SimulatedIntent> | undefined;
  intents(): readonly Readonly<SimulatedIntent>[];
  /** The processor becomes definitive about a pending PaymentIntent. Moves nothing Frontera asked for. */
  settle(id: string): void;
  fail(id: string, code?: string): void;
  cancel(id: string): void;
  /** Rewrites an object's facts (adversarial matrices only). */
  tamper(id: string, patch: Partial<SimulatedIntent>): void;
  /** Stripe prunes idempotency keys after their retention window. */
  pruneIdempotency(): void;
  /** Total money-moving effects Stripe performed: successful charges. */
  charges(): number;
}

const cents = (value: bigint | null): string | null => (value === null ? null : value.toString());

function viewOf(intent: SimulatedIntent): Record<string, unknown> {
  return {
    id: intent.id,
    status: intent.status,
    livemode: intent.livemode,
    amountCents: intent.amountCents.toString(),
    amountReceivedCents: intent.amountReceivedCents.toString(),
    currency: intent.currency,
    customerId: intent.customerId,
    paymentMethodId: intent.paymentMethodId,
    destinationAccountId: intent.destinationAccountId,
    transferAmountCents: cents(intent.transferAmountCents),
    onBehalfOf: intent.onBehalfOf,
    applicationFeeCents: cents(intent.applicationFeeCents),
    captureMethod: intent.captureMethod,
    confirmationMethod: intent.confirmationMethod,
    executionId: intent.executionId,
    railId: intent.railId,
    lastPaymentError: intent.lastPaymentError,
    latestChargeId: intent.latestChargeId,
  };
}

const never = (): Promise<never> => new Promise(() => undefined);

export function createSimulatedStripe(options: { readonly platformAccountId?: string; readonly mirrorOf?: SimulatedStripe } = {}): SimulatedStripe {
  const platformAccountId = options.platformAccountId ?? PLATFORM_ACCOUNT;
  const mirror = options.mirrorOf as (SimulatedStripe & { readonly ledger: SharedLedger }) | undefined;
  const ledger: SharedLedger = mirror?.ledger ?? { intents: new Map(), idempotency: new Map(), sequence: 0 };
  const calls = { create: 0, confirmAttempted: 0, confirmReceived: 0, retrieve: 0, account: 0 };
  const instructions = { create: [] as StripeCreateInstruction[], confirm: [] as StripeConfirmInstruction[] };

  const sim = {
    ledger,
    platformAccountId,
    calls,
    instructions,
    createBehaviour: 'ok' as SimulatedCreateBehaviour,
    confirmBehaviour: 'succeed' as SimulatedConfirmBehaviour,
    readMode: 'normal' as 'normal' | 'unavailable' | 'live',

    async retrieveAccount(): Promise<unknown> {
      calls.account += 1;
      if (sim.readMode === 'unavailable') throw new Error('stripe unavailable');
      return { accountId: platformAccountId, livemode: sim.readMode === 'live' };
    },

    async retrievePaymentIntent(paymentIntentId: string): Promise<unknown> {
      calls.retrieve += 1;
      if (sim.readMode === 'unavailable') throw new Error('stripe unavailable');
      const intent = ledger.intents.get(paymentIntentId);
      return intent === undefined ? { notFound: true } : viewOf(intent);
    },

    async createPaymentIntent(instruction: StripeCreateInstruction): Promise<unknown> {
      calls.create += 1;
      instructions.create.push(instruction);
      if (sim.createBehaviour === 'fail') throw new Error('stripe create failed');
      const parameters = JSON.stringify({ ...instruction, amountCents: instruction.amountCents.toString(), timeoutMs: undefined });
      const replay = ledger.idempotency.get(instruction.idempotencyKey);
      let intent: SimulatedIntent;
      if (replay !== undefined) {
        if (replay.parameters !== parameters) throw new Error('idempotency key reused with other parameters');
        intent = ledger.intents.get(replay.result)!;
      } else {
        ledger.sequence += 1;
        intent = {
          id: `pi_sim${ledger.sequence}`,
          status: 'requires_confirmation',
          livemode: false,
          amountCents: sim.createBehaviour === 'wrong-amount' ? instruction.amountCents + 1n : instruction.amountCents,
          amountReceivedCents: 0n,
          currency: instruction.currency,
          customerId: instruction.customerId,
          paymentMethodId: instruction.paymentMethodId,
          destinationAccountId: instruction.destinationAccountId,
          transferAmountCents: null,
          onBehalfOf: null,
          applicationFeeCents: null,
          captureMethod: 'automatic',
          confirmationMethod: 'manual',
          executionId: instruction.executionId,
          railId: instruction.railId,
          lastPaymentError: null,
          latestChargeId: null,
        };
        ledger.intents.set(intent.id, intent);
        ledger.idempotency.set(instruction.idempotencyKey, { parameters, result: intent.id });
      }
      if (sim.createBehaviour === 'response-lost') throw new Error('connection reset');
      return viewOf(intent);
    },

    async confirmPaymentIntent(instruction: StripeConfirmInstruction): Promise<unknown> {
      calls.confirmAttempted += 1;
      instructions.confirm.push(instruction);
      const behaviour = sim.confirmBehaviour;
      if (behaviour === 'not-sent') throw new StripeRequestNotSentError();
      calls.confirmReceived += 1;
      const replay = ledger.idempotency.get(instruction.idempotencyKey);
      const intent = ledger.intents.get(instruction.paymentIntentId);
      if (intent === undefined) throw new Error('no such payment intent');
      if (replay !== undefined) return viewOf(ledger.intents.get(replay.result)!);
      ledger.idempotency.set(instruction.idempotencyKey, { parameters: instruction.paymentIntentId, result: intent.id });
      if (intent.status !== 'requires_confirmation' && intent.status !== 'requires_payment_method') throw new Error('payment intent cannot be confirmed in its state');
      switch (behaviour) {
        case 'succeed':
        case 'succeed-response-lost':
        case 'succeed-never-answers':
          sim.settle(intent.id);
          break;
        case 'decline':
          sim.fail(intent.id, 'card_declined');
          break;
        case 'authentication-required':
          sim.fail(intent.id, 'authentication_required');
          break;
        case 'processing':
        case 'processing-response-lost':
          intent.status = 'processing';
          break;
        case 'requires-action':
          intent.status = 'requires_action';
          break;
        case 'requires-capture':
          intent.status = 'requires_capture';
          break;
      }
      if (behaviour === 'succeed-response-lost' || behaviour === 'processing-response-lost') throw new Error('connection reset after the request was read');
      if (behaviour === 'succeed-never-answers') return never();
      return viewOf(intent);
    },

    intent: (id: string) => ledger.intents.get(id),
    intents: () => [...ledger.intents.values()],

    settle(id: string): void {
      const intent = ledger.intents.get(id)!;
      intent.status = 'succeeded';
      intent.amountReceivedCents = intent.amountCents;
      intent.lastPaymentError = null;
      intent.latestChargeId = `ch_sim${id.slice('pi_sim'.length)}`;
    },
    fail(id: string, code = 'card_declined'): void {
      const intent = ledger.intents.get(id)!;
      intent.status = 'requires_payment_method';
      intent.lastPaymentError = code;
      intent.paymentMethodId = null;
      intent.latestChargeId = `ch_sim${id.slice('pi_sim'.length)}`;
    },
    cancel(id: string): void {
      const intent = ledger.intents.get(id)!;
      intent.status = 'canceled';
    },
    tamper(id: string, patch: Partial<SimulatedIntent>): void {
      Object.assign(ledger.intents.get(id)!, patch);
    },
    pruneIdempotency(): void {
      ledger.idempotency.clear();
    },
    charges(): number {
      return [...ledger.intents.values()].filter((intent) => intent.status === 'succeeded').length;
    },
  };
  return sim;
}

/**
 * An in-memory interlock for rail-level unit tests (the durable, CORE-07-anchored
 * one is `src/enterprise/stripe-payment-rail/sqlite-stripe-payment-interlock.ts`).
 * `failNext` injects a failure into the next write of a kind.
 */
export function createMemoryStripeInterlock(): StripePaymentInterlock & {
  readonly records: Map<string, StripePaymentReservationRecord>;
  failNext: 'reserve' | 'bind' | 'recorded' | undefined;
} {
  const records = new Map<string, StripePaymentReservationRecord>();
  const store = {
    records,
    failNext: undefined as 'reserve' | 'bind' | 'recorded' | undefined,
    async recorded(executionId: string): Promise<StripePaymentReservationRecord | undefined> {
      if (store.failNext === 'recorded') {
        store.failNext = undefined;
        throw new Error('interlock unavailable');
      }
      return records.get(executionId);
    },
    async reserve(record: StripePaymentReservationInput): Promise<StripePaymentReservation> {
      if (store.failNext === 'reserve') {
        store.failNext = undefined;
        throw new Error('interlock unavailable');
      }
      const existing = records.get(record.executionId);
      if (existing !== undefined) return { outcome: 'execution-recorded', record: existing };
      records.set(record.executionId, Object.freeze({ ...record }));
      return { outcome: 'reserved' };
    },
    async bind(executionId: string, paymentIntentId: string): Promise<StripePaymentBinding> {
      if (store.failNext === 'bind') {
        store.failNext = undefined;
        throw new Error('interlock unavailable');
      }
      const existing = records.get(executionId);
      if (existing === undefined) return { outcome: 'not-reserved' };
      if (existing.paymentIntentId !== undefined) return { outcome: 'execution-bound', paymentIntentId: existing.paymentIntentId };
      if ([...records.values()].some((record) => record.paymentIntentId === paymentIntentId)) return { outcome: 'payment-intent-bound-elsewhere' };
      records.set(executionId, Object.freeze({ ...existing, paymentIntentId }));
      return { outcome: 'bound' };
    },
  };
  return store;
}
