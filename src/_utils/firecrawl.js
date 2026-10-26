// Results per search. Firecrawl charges 2 credits per 10, so the free plan's 1,000 credits a month buy 500 searches
export const FIRECRAWL_RESULTS = 10;

// { urls } ([] if none found), or { error } if Firecrawl refused or failed, e.g. 402 once the month's credits run out,
// or 429 past the free plan's 10 searches a minute or 2 at once
export async function firecrawlImageSearch(query, apiKey) {
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      // SafeSearch off, like Brave. It's off by default too, but set so a default change can't filter results
      body: JSON.stringify({ query, sources: ["images"], limit: FIRECRAWL_RESULTS, safe: false }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const data = await res.json();
    if (!data.success) return { error: JSON.stringify(data).slice(0, 300) };
    return { urls: data.data?.images?.map(r => r.imageUrl).filter(url => !!url) || [] };
  } catch (err) {
    return { error: err.name === "TimeoutError" ? "Timeout" : err.message };
  }
}
