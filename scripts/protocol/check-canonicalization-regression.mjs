#!/usr/bin/env node
// Frontera-side consumer regression: proves the INSTALLED @aoc/protocol
// dependency is the repaired candidate, not the burned one.
//
// @aoc/protocol@0.2.0-rc.0 was BURNED because its canonical-JSON writer
// truncated exponent digits: canonicalizeJSON(7.9e-10) and
// canonicalizeJSON(7.9e-100) both produced "7.9e-1". Two distinct numbers
// with one canonical form is a digest collision, and every Frontera record
// whose integrity rests on a canonical digest inherits it. 0.2.0-rc.1
// (source commit eec79cdd4019dd42e1767909c5bd4e26d04c6f0f) repairs it.
//
// This does NOT duplicate Protocol's ownership of canonicalization -- the
// algorithm, its profile and its own test suite stay Protocol's. What this
// asserts is a *consumption* fact Frontera alone can assert: the artifact
// resolved by this repository's own `node_modules/@aoc/protocol` behaves
// like rc.1 and its successors (the active pin is 0.2.0-rc.3, see
// protocol-consumer.lock.json). It fails loudly if a future change
// reintroduces rc.0.
//
// It lives under scripts/protocol/ deliberately. `./canonical` is a declared
// public export of @aoc/protocol, but Frontera's own boundary gates
// (check-protocol-consumption.mjs, check-node16-imports.mjs and the tarball
// validator's forbidden-import scan) forbid EVERY '@aoc/protocol/<subpath>'
// specifier in src/, packages/, tests/ and types/, and all three already
// exempt scripts/protocol as the protocol tooling that must name such
// specifiers. Putting the probe here keeps those gates load-bearing at full
// strength instead of widening them for one file -- Frontera source still
// may not import any Protocol subpath.
//
// Publishes nothing, installs nothing, writes nothing. Prints a JSON
// evidence object as its final stdout line.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { canonicalizeJSON } from '@aoc/protocol/canonical';

const ROOT = resolve(process.cwd());
const require_ = createRequire(import.meta.url);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  process.stderr.write(`[canonicalization] ${ok ? 'PASS' : 'FAIL'}  ${message}\n`);
};

// --- The installed artifact must be the one the compatibility lock pins ----
const lock = JSON.parse(readFileSync(resolve(ROOT, 'protocol-consumer.lock.json'), 'utf8'));
const installed = require_('@aoc/protocol/package.json');
check(
  installed.version === lock.expectedVersion,
  `installed @aoc/protocol is ${installed.version}, the version protocol-consumer.lock.json pins (${lock.expectedVersion})`,
);
check(
  installed.version !== '0.2.0-rc.0',
  'installed @aoc/protocol is not the burned 0.2.0-rc.0 candidate',
);

// integration-contract.json ships in the artifact but is not an exports-map
// entry, so it is read from the installed package's own directory (located
// through './package.json', which IS a declared export) rather than required
// through a subpath the package does not expose.
const installedPackageDir = dirname(require_.resolve('@aoc/protocol/package.json'));
const installedContract = JSON.parse(readFileSync(join(installedPackageDir, 'integration-contract.json'), 'utf8'));
check(
  installedContract.contractVersion === lock.integrationContract.contractVersion,
  `installed integration contract is ${installedContract.contract}@${installedContract.contractVersion}, the version the lock records (${lock.integrationContract.contractVersion})`,
);

// --- The defect itself, through the installed package's public export ------
const SMALL = 7.9e-10;
const SMALLER = 7.9e-100;

const small = canonicalizeJSON(SMALL);
const smaller = canonicalizeJSON(SMALLER);

check(small === '7.9e-10', `canonicalizeJSON(7.9e-10) === "7.9e-10" (got ${JSON.stringify(small)})`);
check(smaller === '7.9e-100', `canonicalizeJSON(7.9e-100) === "7.9e-100" (got ${JSON.stringify(smaller)})`);
check(small !== smaller, 'the two canonical forms are distinct (rc.0 collapsed both to "7.9e-1")');

const smallDigest = sha256(small);
const smallerDigest = sha256(smaller);
check(smallDigest !== smallerDigest, 'the two canonical digests are distinct');

// A canonical form that is distinct but no longer parses back to the value it
// came from would trade a collision for a corruption, so round-trip both.
const roundTrip = (value, canonical) => JSON.parse(canonical) === value;
check(roundTrip(SMALL, small), 'canonical form of 7.9e-10 round-trips back to the original number');
check(roundTrip(SMALLER, smaller), 'canonical form of 7.9e-100 round-trips back to the original number');

// The defect was exponent-digit truncation, so it was never confined to these
// two literals. A representative spread guards the neighbourhood rather than
// only the reported reproduction.
for (const value of [1e-5, 1e-10, 1e-100, 1e5, 1e21, 1.5e-300, 9.87654321e-99]) {
  const canonical = canonicalizeJSON(value);
  check(
    JSON.parse(canonical) === value,
    `canonicalizeJSON(${value}) round-trips (got ${JSON.stringify(canonical)})`,
  );
}

const evidence = {
  installedProtocolVersion: installed.version,
  pinnedProtocolVersion: lock.expectedVersion,
  integrationContract: `${installedContract.contract}@${installedContract.contractVersion}`,
  'canonicalizeJSON(7.9e-10)': small,
  'canonicalizeJSON(7.9e-100)': smaller,
  outputsDistinct: small !== smaller,
  digestsDistinct: smallDigest !== smallerDigest,
  roundTrip: roundTrip(SMALL, small) && roundTrip(SMALLER, smaller) ? 'PASS' : 'FAIL',
  failures,
};
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

if (failures.length > 0) {
  process.stderr.write(
    `[canonicalization] ${failures.length} check(s) failed. If canonicalizeJSON(7.9e-10) reported "7.9e-1", this repository is consuming the BURNED @aoc/protocol@0.2.0-rc.0 candidate; repin it to the active candidate recorded in protocol-consumer.lock.json (0.2.0-rc.1 and later carry the repair).\n`,
  );
  process.exitCode = 1;
}
