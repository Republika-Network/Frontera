import { isIPv4, isIPv6 } from 'node:net';

/**
 * The Generic HTTP adapter's destination policy: which resolved addresses a
 * governed effect may connect to. Pure — no I/O, no DNS, no clock.
 *
 * ## Fail closed on anything not provably public
 *
 * The policy answers one question about one address string: is it a publicly
 * routable unicast destination? Anything it cannot parse, any representation it
 * does not recognise, and every special-purpose range below is **forbidden**.
 * It does not try to outsmart alternate encodings: an IPv4-mapped, IPv4-compatible,
 * NAT64, 6to4 or Teredo IPv6 address could route to a private IPv4 host, so the
 * whole class is refused rather than decoded.
 *
 * IPv6 is an **allow-list** — only global unicast `2000::/3`, minus the
 * reserved blocks inside it — because the special-purpose space outside it is
 * large and still growing. IPv4 is a deny-list of the special-purpose registry,
 * which is small and stable.
 *
 * This is application-level destination control for one adapter. It is **not**
 * a network egress firewall: other code in the process can still open sockets
 * (SEC-INV-U03, SEC-TRUST-004).
 */

/** `[network, prefixLength]`, IPv4. Each entry is a special-purpose range a governed effect may never reach. */
const FORBIDDEN_IPV4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared address space (CGNAT)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — includes cloud metadata at 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // deprecated 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including limited broadcast
];

function ipv4ToInt(address: string): number | undefined {
  if (!isIPv4(address)) return undefined;
  const octets = address.split('.');
  if (octets.length !== 4) return undefined;
  let value = 0;
  for (const octet of octets) {
    // `isIPv4` already refuses leading zeros and out-of-range octets; this is
    // belt and braces so an unexpected spelling fails rather than wraps.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(octet)) return undefined;
    const parsed = Number(octet);
    if (parsed > 255) return undefined;
    value = value * 256 + parsed;
  }
  return value;
}

function inIpv4Range(value: number, network: string, prefix: number): boolean {
  const base = ipv4ToInt(network);
  if (base === undefined) return true;
  const size = 2 ** (32 - prefix);
  return value >= base && value < base + size;
}

/** Whether an IPv4 dotted-quad is a publicly routable unicast destination. Unparseable is `false`. */
export function isPublicIpv4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === undefined) return false;
  return !FORBIDDEN_IPV4.some(([network, prefix]) => inIpv4Range(value, network, prefix));
}

/**
 * Eight 16-bit groups, or `undefined` for anything that is not a plain IPv6
 * address. A zone index (`fe80::1%eth0`) and an embedded dotted-quad tail are
 * both refused: the first is a link-local construct, the second is exactly the
 * alternate-representation class this policy declines to reason about.
 */
function ipv6Groups(address: string): readonly number[] | undefined {
  if (!isIPv6(address)) return undefined;
  if (address.includes('%') || address.includes('.')) return undefined;
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part.length === 0) return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** `[first group, second group or undefined, prefixLength]` — reserved blocks inside `2000::/3`. */
const FORBIDDEN_IPV6_IN_GLOBAL: readonly (readonly [number, number, number])[] = [
  [0x2001, 0x0000, 23], // IETF protocol assignments, including Teredo 2001::/32 (embeds IPv4)
  [0x2001, 0x0db8, 32], // documentation
  [0x2002, 0x0000, 16], // 6to4 (embeds IPv4)
  [0x3fff, 0x0000, 20], // documentation (RFC 9637)
];

function inIpv6Prefix(groups: readonly number[], first: number, second: number, prefix: number): boolean {
  const value = ((groups[0] ?? 0) * 0x10000 + (groups[1] ?? 0)) >>> 0;
  const base = (first * 0x10000 + second) >>> 0;
  const mask = prefix >= 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (base & mask) >>> 0;
}

/**
 * Whether an IPv6 address is a publicly routable unicast destination.
 *
 * Only global unicast `2000::/3` can pass, which by itself excludes `::`,
 * `::1`, IPv4-mapped `::ffff:0:0/96`, IPv4-compatible `::/96`, NAT64
 * `64:ff9b::/96` and `64:ff9b:1::/48`, discard `100::/64`, unique-local
 * `fc00::/7`, link-local `fe80::/10`, site-local `fec0::/10` and multicast
 * `ff00::/8`. The reserved blocks inside `2000::/3` are then removed.
 */
export function isPublicIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (groups === undefined) return false;
  const first = groups[0] ?? 0;
  if (first < 0x2000 || first > 0x3fff) return false;
  return !FORBIDDEN_IPV6_IN_GLOBAL.some(([a, b, prefix]) => inIpv6Prefix(groups, a, b, prefix));
}

/** One resolved destination, exactly as the resolver returned it. */
export interface GenericHttpResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Whether one resolved answer is a public destination. The declared family must agree with the address syntax. */
export function isPublicResolvedAddress(candidate: GenericHttpResolvedAddress): boolean {
  if (candidate.family === 4) return isPublicIpv4(candidate.address);
  if (candidate.family === 6) return isPublicIpv6(candidate.address);
  return false;
}

export type GenericHttpAddressSelection =
  | { readonly kind: 'approved'; readonly address: GenericHttpResolvedAddress }
  | { readonly kind: 'no-answer' }
  | { readonly kind: 'forbidden' };

/**
 * Judge **every** answer, then pick exactly one.
 *
 * A resolver that returns one public and one private address has told us the
 * name can mean a private host, and the whole answer is refused — picking the
 * public one would leave the choice to whichever the resolver lists first next
 * time. With every answer public, the first is chosen, and it is the only
 * address this execution will ever connect to: there is no fallback to a
 * second answer, because a second connection attempt is a second provider
 * attempt.
 */
export function selectApprovedAddress(answers: readonly GenericHttpResolvedAddress[]): GenericHttpAddressSelection {
  if (answers.length === 0) return { kind: 'no-answer' };
  for (const answer of answers) {
    if (!isPublicResolvedAddress(answer)) return { kind: 'forbidden' };
  }
  const chosen = answers[0];
  if (chosen === undefined) return { kind: 'no-answer' };
  return { kind: 'approved', address: Object.freeze({ address: chosen.address, family: chosen.family }) };
}

/**
 * Hostnames refused before any DNS query: loopback and local-only names whose
 * meaning is the host itself or its private network. The DNS answer policy is
 * the real gate; this refuses the trivially local names outright so a
 * deployment that configured one fails at startup rather than per request.
 */
const LOCAL_ONLY_SUFFIXES: readonly string[] = ['.localhost', '.local', '.localdomain', '.internal', '.home.arpa', '.in-addr.arpa', '.ip6.arpa'];

export function isLocalOnlyHostname(hostname: string): boolean {
  const name = hostname.toLowerCase();
  if (name === 'localhost' || name === 'localhost.localdomain') return true;
  return LOCAL_ONLY_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
