function timeoutSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}

async function parseResponse(response, provider) {
  if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}`);
  return response.json();
}

export function createGeoProviders({ fetchImpl = fetch, timeoutMs = 2_500 } = {}) {
  return {
    async providerA(ip) {
      const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,city`;
      const response = await fetchImpl(url, { signal: timeoutSignal(timeoutMs) });
      const data = await parseResponse(response, 'ip-api.com');
      if (data.status !== 'success') throw new Error('ip-api.com could not locate this IP');
      return { country: data.country ?? null, city: data.city ?? null, provider: 'ip-api.com' };
    },
    async providerB(ip) {
      const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
      const response = await fetchImpl(url, { signal: timeoutSignal(timeoutMs) });
      const data = await parseResponse(response, 'ipapi.co');
      if (data.error || (!data.country_name && !data.city)) throw new Error('ipapi.co could not locate this IP');
      return { country: data.country_name ?? null, city: data.city ?? null, provider: 'ipapi.co' };
    },
  };
}

export async function enrichGeo(ip, providers) {
  if (!ip) return null;
  for (const name of ['providerA', 'providerB']) {
    try {
      const result = await providers[name](ip);
      if (result && (result.country || result.city)) return result;
    } catch (error) {
      // Deliberately do not log the visitor IP or provider response body.
      console.warn(JSON.stringify({ event: 'geo_provider_failed', provider: name }));
    }
  }
  return null;
}
