/**
 * x402 v2 vectors, verbatim from x402-foundation/x402 @ f8f83309706b14cc696962f0a002eeeb66c3dc26 (Apache-2.0):
 *
 * - `specs/transports-v2/http.md` (sha256 4f0298aaa23ac75de0eb49b1e96e6e67a5b910d7527b3a71c63e426b3bf5bdfb): the example
 *   `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE` header values;
 * - `specs/schemes/exact/scheme_exact_lnbtc.md` (sha256 20711e1556930cb8e8f48ad471491f3f6c912ea78e688cc814da9d24b7f9d56b): the
 *   deterministic test vector requirement and its HTTP request-binding digests.
 *
 * Compact vectors only — no specification text. Malformed variations are built
 * locally in the tests. The lnbtc invoice is the specification's test vector,
 * signed by the specification with its published test-only key; no private key
 * is held here.
 */

/** The EVM example `PaymentRequired` (eip155:84532, USDC) — parsable, not executable by any Frontera mapping. */
export const SPEC_PAYMENT_REQUIRED_HEADER = 'eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQQVlNRU5ULVNJR05BVFVSRSBoZWFkZXIgaXMgcmVxdWlyZWQiLCJyZXNvdXJjZSI6eyJ1cmwiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbS9wcmVtaXVtLWRhdGEiLCJkZXNjcmlwdGlvbiI6IkFjY2VzcyB0byBwcmVtaXVtIG1hcmtldCBkYXRhIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzMiIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDAzNkNiRDUzODQyYzU0MjY2MzRlNzkyOTU0MWVDMjMxOGYzZENGN2UiLCJwYXlUbyI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAzQzUxNEVGMzEyMjg3QyIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoiMiJ9fV19';

/** The EVM example `PaymentPayload`. */
export const SPEC_PAYMENT_SIGNATURE_HEADER = 'eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vcHJlbWl1bS1kYXRhIiwiZGVzY3JpcHRpb24iOiJBY2Nlc3MgdG8gcHJlbWl1bSBtYXJrZXQgZGF0YSIsIm1pbWVUeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LCJhY2NlcHRlZCI6eyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJhbW91bnQiOiIxMDAwMCIsImFzc2V0IjoiMHgwMzZDYkQ1Mzg0MmM1NDI2NjM0ZTc5Mjk1NDFlQzIzMThmM2RDRjdlIiwicGF5VG8iOiIweDIwOTY5M0JjNmFmYzBDNTMyOGJBMzZGYUYwM0M1MTRFRjMxMjI4N0MiLCJtYXhUaW1lb3V0U2Vjb25kcyI6NjAsImV4dHJhIjp7Im5hbWUiOiJVU0RDIiwidmVyc2lvbiI6IjIifX0sInBheWxvYWQiOnsic2lnbmF0dXJlIjoiMHgyZDZhNzU4OGQ2YWNjYTUwNWNiZjBkOWE0YTIyN2UwYzUyYzZjMzQwMDhjOGU4OTg2YTEyODMyNTk3NjQxNzM2MDhhMmNlNjQ5NjY0MmUzNzdkNmRhOGRiYmY1ODM2ZTliZDE1MDkyZjllY2FiMDVkZWQzZDYyOTNhZjE0OGI1NzFjIiwiYXV0aG9yaXphdGlvbiI6eyJmcm9tIjoiMHg4NTdiMDY1MTlFOTFlM0E1NDUzODc5MWJEYmIwRTIyMzczZTM2YjY2IiwidG8iOiIweDIwOTY5M0JjNmFmYzBDNTMyOGJBMzZGYUYwM0M1MTRFRjMxMjI4N0MiLCJ2YWx1ZSI6IjEwMDAwIiwidmFsaWRBZnRlciI6IjE3NDA2NzIwODkiLCJ2YWxpZEJlZm9yZSI6IjE3NDA2NzIxNTQiLCJub25jZSI6IjB4ZjM3NDY2MTNjMmQ5MjBiNWZkYWJjMDg1NmYyYWViMmQ0Zjg4ZWU2MDM3YjhjYzVkMDRhNzFhNDQ2MmYxMzQ4MCJ9fX0=';

/** The example `SettlementResponse`s: success, then failure (`insufficient_funds`). */
export const SPEC_PAYMENT_RESPONSE_SUCCESS_HEADER = 'eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWYxMjM0NTY3ODkwYWJjZGVmMTIzNDU2Nzg5MGFiY2RlZiIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJwYXllciI6IjB4ODU3YjA2NTE5RTkxZTNBNTQ1Mzg3OTFiRGJiMEUyMjM3M2UzNmI2NiJ9';
export const SPEC_PAYMENT_RESPONSE_FAILURE_HEADER = 'eyJzdWNjZXNzIjpmYWxzZSwiZXJyb3JSZWFzb24iOiJpbnN1ZmZpY2llbnRfZnVuZHMiLCJ0cmFuc2FjdGlvbiI6IiIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJwYXllciI6IjB4ODU3YjA2NTE5RTkxZTNBNTQ1Mzg3OTFiRGJiMEUyMjM3M2UzNmI2NiJ9';

/** The lnbtc test vector: GET https://api.example.com/article/A, empty body, no bound headers; validation time 1700000000. */
export const SPEC_LNBTC_VECTOR = Object.freeze({
  validationTimeSeconds: 1_700_000_000,
  url: 'https://api.example.com/article/A',
  method: 'GET',
  requestHash: '0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018',
  /** The same request for article B. */
  requestHashArticleB: '4a99860f75eed1ea8178a5db488e044173bc570c8a6210f2c8590cdf8622d509',
  requirement: Object.freeze({
    scheme: 'exact',
    network: 'lnbtc:000000000019d6689c085ae165831e93',
    amount: '25000',
    asset: 'BTC',
    payTo: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    maxTimeoutSeconds: 300,
    extra: Object.freeze({
      assetTransferMethod: 'bolt11',
      paymentFlow: 'upfront',
      requestHash: '0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018',
      requestBindingProfile: 'http:1',
      requestBindingParams: Object.freeze({ headers: Object.freeze([]) }),
      invoice: 'lnbc250n1pj48ugqpp54y3u9s8ylemsv8l3ewyzzu0klhujvuvmkl6llchq23vy8rzjsf0qsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp5p4nz8am4uqj4q8a87z3sk4x6yk4dv2mvel34epw68qqkwy0xcqvqxqzfvcqpjr4rx6ls6j5rpwknuea64evlk7yfx56wmqcer5eerekdsn9tlv6v4ex9mlz5dtm9qapl3svwlqcf7837dmjkru9z9w4h2rvm0md52w2sqxrwu5f',
    }),
  }),
  /** The payment hash the invoice commits to (SettlementResponse.transaction in the spec's success example). */
  paymentHash: 'a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e',
});
