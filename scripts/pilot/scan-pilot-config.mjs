// `npm run pilot:scan-config -- <file>...` — PROD-03: refuses a pilot
// configuration package that carries a secret.
//
// The governed-action file, the kit's .env.example and any other file meant to
// be committed must name secrets by the environment variable that holds them,
// never hold one. This is not a general secret scanner: it looks only for the
// shapes a Frontera pilot's own secrets take — private keys, bearer
// credentials, operator-issued agent credentials, Stripe keys, node
// macaroons, inline secret fields, wallet seeds, and an assigned authority
// key or credential variable. A hit prints the file, the line number and the
// kind — never the matched text. Exit 0: nothing found; 1: something found;
// 2: usage.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Assignments whose value is an `<…>` placeholder, a variable reference or empty (a trailing comment ignored): never a secret. */
const PLACEHOLDER = /^['"]?(?:<.*>|\$\{?[A-Z_][A-Z0-9_]*\}?|)['"]?(?:\s+#.*)?$/;

export const SECRET_SHAPES = Object.freeze([
  { kind: 'private-key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { kind: 'agent-credential', pattern: /\bfra1\.agc-[0-9a-f]{32}\.[A-Za-z0-9_-]{43}\b/ },
  { kind: 'bearer-credential', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  { kind: 'stripe-key', pattern: /\b(?:sk|rk|whsec)_(?:live|test)?_?[A-Za-z0-9]{16,}/ },
  { kind: 'macaroon', pattern: /\b[0-9a-f]{120,}\b/ },
  { kind: 'inline-secret-field', pattern: /"(?:token|apiKey|api_key|password|passphrase|secret|clientSecret|macaroon|privateKey|privateKeyPem|seed|mnemonic)"\s*:\s*"(?!<required)[^"$]{8,}"/i },
  // An XRPL family seed (29 base58 characters starting with `s`); mnemonic phrases are not pattern-matched (prose would match).
  { kind: 'wallet-seed', pattern: /\bs[1-9A-HJ-NP-Za-km-z]{28}\b/ },
]);

/** Variables that hold secrets in a pilot deployment; an assignment of a real value to one is a secret. */
const SECRET_VARIABLE = /^(?:AOC_ENTERPRISE_(?:AUTHORITY_SIGNING_KEY_PEM|AUTHORITY_SIGNER_TOKEN|AUTHORITY_FRESHNESS_TOKEN|API_KEYS)|FRONTERA_(?:OPERATOR_KEY_[A-Z0-9_]+|PROVIDER_TOKEN|AUDITOR_[A-Z0-9_]*KEY|[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD)))$/;

/** Every finding in one text: `{ line, kind }`, never the value. */
export function scanForSecrets(text) {
  const findings = [];
  text.split('\n').forEach((line, index) => {
    for (const shape of SECRET_SHAPES) if (shape.pattern.test(line)) findings.push({ line: index + 1, kind: shape.kind });
    const assignment = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (assignment !== null && SECRET_VARIABLE.test(assignment[1]) && !PLACEHOLDER.test(assignment[2].trim())) findings.push({ line: index + 1, kind: `assigned-secret-variable:${assignment[1]}` });
  });
  return findings;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: scan-pilot-config.mjs <file>...');
    process.exitCode = 2;
  } else {
    let found = 0;
    for (const file of files) {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        console.error(`${file}: unreadable`);
        process.exitCode = 2;
        continue;
      }
      for (const finding of scanForSecrets(text)) {
        found += 1;
        console.log(`${file}:${finding.line}: ${finding.kind}`);
      }
    }
    if (process.exitCode !== 2) {
      console.log(found === 0 ? `RESULT: PASS (${files.length} file${files.length === 1 ? '' : 's'}, no secret found)` : `RESULT: FAIL (${found} finding${found === 1 ? '' : 's'}; the values are not printed)`);
      process.exitCode = found === 0 ? 0 : 1;
    }
  }
}
