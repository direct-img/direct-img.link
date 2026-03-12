export async function braveImageSearch(query, apiKey) {
  const res = await fetch(`https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}&count=50&safesearch=off`, {
    headers: { "Accept": "application/json", "X-Subscription-Token": apiKey },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.results?.map(r => r.properties?.url || r.thumbnail?.src).filter(url => !!url) || null;
}
