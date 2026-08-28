// Approximate region from an IP address, for name weighting. Nothing else.
//
// PRIVACY - the whole contract, in one place:
//
//   * Resolution is OFFLINE. geoip-lite ships its database inside the package
//     and is queried in this process, so the player's IP address is never sent
//     to a third party. That is the entire reason this is not an API call to a
//     geolocation service.
//   * The IP is used and dropped inside resolveRegion(). It is never logged,
//     never returned to the client, and never written anywhere.
//   * What LEAVES this file is a region code and nothing else: "US-MN", or a
//     bare country like "DE". geoip-lite also hands back a city, coordinates,
//     a timezone and a metro code on every lookup - all of it is discarded
//     here, deliberately, and must stay discarded.
//   * The stored value is therefore coarse by construction. A US state is
//     millions of people; it cannot single anybody out, and it is the coarsest
//     thing that still carries a name-frequency signal.
//   * IP geolocation is WRONG for a great many people - VPNs, mobile carriers
//     routing through another state, corporate egress, satellite links. So the
//     result is only ever a default. The player can override it to any region
//     or switch it off entirely (client/src/prefs.js, the settings dropdown),
//     and their choice always wins over anything resolved here.

import geoip from 'geoip-lite';
import { regionFromGeo } from '../shared/regions.js';

// Loopback and RFC1918 space: a developer on localhost, or anyone behind a
// proxy that did not forward a public address. There is nothing to look up.
const PRIVATE_IP = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:)/i;

/** Strip the IPv6-mapped-IPv4 prefix Express hands back on dual-stack sockets. */
export function normalizeIp(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const ip = raw.trim().replace(/^::ffff:/i, '');
  return ip || null;
}

/**
 * Resolve a request to a coarse region code, or null.
 *
 * @param {string} ip  caller-supplied; used and discarded, never stored
 * @returns {{ region: string|null, reason: string }}
 */
export function resolveRegion(ip) {
  const address = normalizeIp(ip);
  if (!address) return { region: null, reason: 'no address' };
  if (PRIVATE_IP.test(address)) return { region: null, reason: 'private address' };

  let hit = null;
  try {
    hit = geoip.lookup(address);
  } catch {
    // A broken database is not worth failing a request over - names simply
    // fall back to era-only selection, which is a complete game.
    return { region: null, reason: 'lookup failed' };
  }
  if (!hit) return { region: null, reason: 'not in database' };

  // Only these two fields are read. hit.city, hit.ll (coordinates), hit.metro
  // and hit.timezone are all available here and are all deliberately ignored.
  const region = regionFromGeo({ country: hit.country, region: hit.region });
  return region
    ? { region, reason: 'resolved' }
    : { region: null, reason: 'no usable region' };
}
