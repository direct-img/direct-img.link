// { urls } ([] if none found), or { error } if Brave refused or failed, e.g. once our rate or spending limit is hit
export async function braveImageSearch(query, apiKey) {
  try {
    const res = await fetch(`https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}&count=100&safesearch=off`, {
      headers: { "Accept": "application/json", "X-Subscription-Token": apiKey },
    });
    if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const data = await res.json();
    return { urls: data.results?.map(r => r.properties?.url || r.thumbnail?.src).filter(url => !!url) || [] };
  } catch (err) {
    return { error: err.message };
  }
}
