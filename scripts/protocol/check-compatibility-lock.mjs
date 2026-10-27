#!/usr/bin/env node
// Validates the format and internal consistency of protocol-consumer.lock.json.
// This is NOT an npm lockfile -- it is a small, auditable record of which
// Soberanía Protocol commit/artifact Soberanía Enterprise has actually been validated
// against (see docs/integration/PROTOCOL_PACKAGE_CONSUMPTION.md).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { PACKAGE_SCOPED_PROTOCOL_SUBPATHS, validateCompatibilityLock } from './lib-protocol-artifact.mjs';

const LOCK_PATH = resolve(process.cwd(), 'protocol-consumer.lock.json');

async function main() {
  if (!existsSync(LOCK_PATH)) {
    console.error(`Missing ${LOCK_PATH}. Run scripts/protocol/build-protocol-tarball.mjs and scripts/protocol/validate-enterprise-against-protocol-tarball.mjs, then record the result here.`);
    process.exitCode = 1;
    return;
  }

  let lock;
  try {
    lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
  } catch (error) {
    console.error(`protocol-consumer.lock.json is not valid JSON: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const { valid, errors } = validateCompatibilityLock(lock);
  // The gates grant these allowances, so the lock must record them (validateCompatibilityLock
  // then holds the record to the code's value exactly).
  if (PACKAGE_SCOPED_PROTOCOL_SUBPATHS.length > 0 && lock.packageScopedPublicExports === undefined) {
    errors.push('Field "packageScopedPublicExports" is required while PACKAGE_SCOPED_PROTOCOL_SUBPATHS grants an allowance.');
  }
  if (!valid || errors.length > 0) {
    console.error('protocol-consumer.lock.json failed validation:');
    for (const error of errors) console.error(` - ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`protocol-consumer.lock.json is valid: ${lock.package}@${lock.expectedVersion} pinned to commit ${lock.commit}.`);
}

main();
