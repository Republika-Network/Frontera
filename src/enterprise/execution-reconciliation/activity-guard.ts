/**
 * PROD-03-02 — the per-execution activity guard: why an operator can never
 * attest a resolution over a provider outcome that is about to be recorded.
 *
 * The provider's initial observation (P11) and a resolution (P12) live in two
 * stores, so neither store's own transaction can order one against the other.
 * The Enterprise Host is a single-process, single-writer design
 * (`docs/operations/DEPLOYMENT_GUIDE_V1.md`), and the only writer of a P11
 * observation is the governed-action orchestrator in this process. This guard
 * orders the two there:
 *
 * ```
 * governed path (shared)           enter(executionId) BEFORE the P11 preparation and the claim
 *                                  … claim → adapter → P11 observation …
 *                                  leave()  AFTER the observation (or any exit)
 *
 * operator attestation (exclusive) tryExclusive(executionId)
 *                                  refused while any governed path holds the execution
 *                                  re-read P11 + the claim → record the P12 resolution
 *                                  release()
 * ```
 *
 * - An operator never waits on a provider: an execution whose adapter call is
 *   in flight **in this process** is refused (`in-flight`), immediately.
 * - While an operator holds it, a governed path for the same execution waits
 *   (briefly) before it prepares or claims — and then finds the claim and
 *   replays, so it never reaches an adapter.
 * - Because the governed path enters before its claim and leaves only after
 *   its observation, an attestation that holds the execution and still sees
 *   "claimed, no observation" is looking at a claim no live call can complete:
 *   the provider outcome, when there is one, wins by being durable first.
 *
 * Process-local by construction, exactly as the single-writer design is. It
 * guards ordering only; it decides nothing and records nothing.
 */
export interface ExecutionActivityGuard {
  /** The governed path: shared with other governed paths, waits while an attestation holds this execution. Resolves to the release function, idempotent. */
  enter(executionId: string): Promise<() => void>;
  /** Operator attestation: exclusive and never waiting. `undefined` while any governed path, or another attestation, holds this execution. */
  tryExclusive(executionId: string): (() => void) | undefined;
  /** Whether a governed path holds this execution now. A read for display only (the operations view's `resolvable`); `tryExclusive` decides. */
  isActive(executionId: string): boolean;
}

interface Slot {
  active: number;
  exclusive: boolean;
  /** Governed paths waiting for an attestation to release. */
  readonly waiting: (() => void)[];
}

export function createExecutionActivityGuard(): ExecutionActivityGuard {
  const slots = new Map<string, Slot>();

  function slotOf(executionId: string): Slot {
    let slot = slots.get(executionId);
    if (slot === undefined) {
      slot = { active: 0, exclusive: false, waiting: [] };
      slots.set(executionId, slot);
    }
    return slot;
  }

  function settle(executionId: string, slot: Slot): void {
    if (slot.active === 0 && !slot.exclusive && slot.waiting.length === 0) slots.delete(executionId);
  }

  function once(release: () => void): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release();
    };
  }

  return Object.freeze({
    async enter(executionId: string): Promise<() => void> {
      let slot = slotOf(executionId);
      while (slot.exclusive) {
        const held = slot;
        await new Promise<void>((wake) => held.waiting.push(wake));
        // Re-read: the slot this path counts itself in is always the one in the map.
        slot = slotOf(executionId);
      }
      const entered = slot;
      entered.active += 1;
      return once(() => {
        entered.active -= 1;
        settle(executionId, entered);
      });
    },

    isActive(executionId: string): boolean {
      return (slots.get(executionId)?.active ?? 0) > 0;
    },

    tryExclusive(executionId: string): (() => void) | undefined {
      const slot = slotOf(executionId);
      if (slot.active > 0 || slot.exclusive) {
        settle(executionId, slot);
        return undefined;
      }
      slot.exclusive = true;
      return once(() => {
        slot.exclusive = false;
        const woken = slot.waiting.splice(0);
        // Woken paths re-read the slot and count themselves in it, so it is kept for them.
        if (woken.length === 0) settle(executionId, slot);
        for (const wake of woken) wake();
      });
    },
  });
}
