// `node scripts/assurance/run-pilot-01-dry-run.mjs --out <new directory>`
// — ASSURE-PILOT-01: runs the synthetic commercial dry run against the real,
// compiled Assurance service (run `npm run build` first) and writes:
//
//   <out>/founding-assessment/        the delivery package (generator + release output only)
//   <out>/trusted-source/assurance-store.snapshot.db   the issuer's store snapshot, kept apart
//
// Everything is synthetic: a fictional cooperative and platform, synthetic
// evidence, and reviewer/approver secrets that are random per run, held in
// memory and never written. The SQLite store lives in <out>/work and is not
// part of the package. Not an audit, not a certification, and no
// authorization for commercial use (docs/enterprise/ASSURE_PILOT_01_COMMERCIAL_DRY_RUN.md).
//
// Then verify independently:
//   node scripts/assurance/verify-commercial-package.mjs <out>/founding-assessment \
//     [--store-copy <out>/trusted-source/assurance-store.snapshot.db]
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
if (outIndex < 0 || argv[outIndex + 1] === undefined) {
  console.error('usage: run-pilot-01-dry-run.mjs --out <new directory>');
  process.exit(2);
}
const out = resolve(argv[outIndex + 1]);
if (existsSync(out) && readdirSync(out).length > 0) {
  console.error(`--out must be a new or empty directory: ${out}`);
  process.exit(2);
}

const scenarioPath = fileURLToPath(new URL('../../dist/src/enterprise/__tests__/assure-pilot-01-scenario.js', import.meta.url));
if (!existsSync(scenarioPath)) {
  console.error('The compiled scenario is missing; run `npm run build` first.');
  process.exit(2);
}
const scenario = await import(pathToFileURL(scenarioPath).href);

mkdirSync(join(out, 'work'), { recursive: true });
mkdirSync(join(out, 'trusted-source'), { recursive: true });
const world = await scenario.buildPilotWorld(join(out, 'work', 'assurance.db'));
try {
  const { assessment, draft, release } = await scenario.runPilotHappyPath(world);
  scenario.writePilotPackage(join(out, 'founding-assessment'), draft, release);
  await scenario.snapshotPilotStore(world, join(out, 'trusted-source', 'assurance-store.snapshot.db'));
  console.log(
    JSON.stringify(
      {
        assessmentId: assessment.assessmentId,
        statuses: Object.fromEntries(assessment.controlEvaluations.map((evaluation) => [evaluation.controlId, evaluation.status])),
        normalizedScore: assessment.score.normalizedScore,
        readiness: draft.content.readiness.status,
        contentDigest: draft.manifest.contentDigest,
        markdownDigest: draft.manifest.markdownDigest,
        releaseDigest: release.releaseDigest,
        package: 'founding-assessment/',
        trustedSource: 'trusted-source/assurance-store.snapshot.db',
      },
      null,
      2,
    ),
  );
} finally {
  await world.store.close();
}
