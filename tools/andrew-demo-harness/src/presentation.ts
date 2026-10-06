import type { SecretGuard } from './secret-guard.js';

/**
 * ANDREW-P0-11 — the terminal story, for someone who is not a developer.
 * Concise checkpoints, no JSON dumps. Every line passes the secret guard
 * before it is written.
 */

const RULE = '-'.repeat(60);
const WIDTH = 28;

export interface Presenter {
  banner(title: string): void;
  fact(label: string, value: string): void;
  line(text?: string): void;
  result(text: string): void;
}

export function createPresenter(write: (line: string) => void, guard: SecretGuard): Presenter {
  const emit = (text: string) => write(guard.check(text));
  return {
    banner(title) {
      emit('');
      emit(RULE);
      emit(title);
      emit(RULE);
    },
    fact(label, value) {
      const dots = '.'.repeat(Math.max(2, WIDTH - label.length));
      emit(`  ${label}${dots} ${value}`);
    },
    line(text = '') {
      emit(text);
    },
    result(text) {
      emit('');
      emit(`RESULT: ${text}`);
    },
  };
}

/** `125000` → `125,000`; decimals kept exactly. Display only — never used to decide. */
export function grouped(value: string): string {
  const [integer = '', fraction] = value.split('.');
  const withCommas = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? withCommas : `${withCommas}.${fraction}`;
}
