'use strict';
// Runs the compiled strict consumer and prints one JSON object:
// { cases: { <name>: outcome }, loaded: [module files], finalizerIsFrozen: boolean }.
const consumer = require('./dist/consumer.js');

consumer
  .runCases()
  .then((cases) => {
    process.stdout.write(`${JSON.stringify({ cases, loaded: Object.keys(require.cache), finalizerIsFrozen: Object.isFrozen(consumer.NON_PRODUCTION_PASS_THROUGH_FINALIZER) })}\n`);
  })
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
