// Region codes for the name weighting, and nothing else.
//
// PRIVACY, stated once and meant throughout: the only location this game ever
// stores is one of the codes below - a US state, or a two-letter country. No
// IP address, no coordinates, no city, no timezone. The server reads an IP to
// derive a code and then forgets it; the code is what reaches the client and
// the profile. See server/geo.js for the resolution side.
//
// Codes are ISO 3166: "US-MN" for a US state, plain "GB" or "DE" for a country
// outside the US. Only US states carry name-frequency data (the source is the
// US Social Security Administration), so every other code resolves to no
// regional weighting at all - which is a supported outcome, not a failure.

export const AUTO = 'auto';
export const NONE = 'none';

export const US_REGIONS = [
  ['US-AL', 'Alabama'],       ['US-AK', 'Alaska'],        ['US-AZ', 'Arizona'],
  ['US-AR', 'Arkansas'],      ['US-CA', 'California'],    ['US-CO', 'Colorado'],
  ['US-CT', 'Connecticut'],   ['US-DE', 'Delaware'],      ['US-DC', 'District of Columbia'],
  ['US-FL', 'Florida'],       ['US-GA', 'Georgia'],       ['US-HI', 'Hawaii'],
  ['US-ID', 'Idaho'],         ['US-IL', 'Illinois'],      ['US-IN', 'Indiana'],
  ['US-IA', 'Iowa'],          ['US-KS', 'Kansas'],        ['US-KY', 'Kentucky'],
  ['US-LA', 'Louisiana'],     ['US-ME', 'Maine'],         ['US-MD', 'Maryland'],
  ['US-MA', 'Massachusetts'], ['US-MI', 'Michigan'],      ['US-MN', 'Minnesota'],
  ['US-MS', 'Mississippi'],   ['US-MO', 'Missouri'],      ['US-MT', 'Montana'],
  ['US-NE', 'Nebraska'],      ['US-NV', 'Nevada'],        ['US-NH', 'New Hampshire'],
  ['US-NJ', 'New Jersey'],    ['US-NM', 'New Mexico'],    ['US-NY', 'New York'],
  ['US-NC', 'North Carolina'],['US-ND', 'North Dakota'],  ['US-OH', 'Ohio'],
  ['US-OK', 'Oklahoma'],      ['US-OR', 'Oregon'],        ['US-PA', 'Pennsylvania'],
  ['US-RI', 'Rhode Island'],  ['US-SC', 'South Carolina'],['US-SD', 'South Dakota'],
  ['US-TN', 'Tennessee'],     ['US-TX', 'Texas'],         ['US-UT', 'Utah'],
  ['US-VT', 'Vermont'],       ['US-VA', 'Virginia'],      ['US-WA', 'Washington'],
  ['US-WV', 'West Virginia'], ['US-WI', 'Wisconsin'],     ['US-WY', 'Wyoming'],
].map(([code, label]) => ({ code, label }));

const VALID = new Set(US_REGIONS.map((r) => r.code));

/** A stored region, or null for "no regional weighting". Never throws. */
export function normalizeRegion(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toUpperCase();
  if (!value || value === NONE.toUpperCase() || value === AUTO.toUpperCase()) return null;
  if (VALID.has(value)) return value;
  // A country outside the US: keep it, so a profile round-trips honestly, even
  // though no weighting data exists for it today.
  if (/^[A-Z]{2}$/.test(value)) return value;
  if (/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(value)) return value;
  return null;
}

/**
 * Turn a geoip lookup into a stored code. US results become "US-XX"; anything
 * else becomes the bare country, which carries no weighting today.
 */
export function regionFromGeo(geo) {
  if (!geo || typeof geo.country !== 'string') return null;
  const country = geo.country.toUpperCase();
  if (country === 'US' && typeof geo.region === 'string' && geo.region) {
    return normalizeRegion('US-' + geo.region.toUpperCase());
  }
  return normalizeRegion(country);
}

export const labelFor = (code) => {
  const found = US_REGIONS.find((r) => r.code === code);
  return found ? found.label : (code || 'Not set');
};
