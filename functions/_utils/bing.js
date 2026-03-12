export async function bingImageSearchFallback(query) {
  try {
    const res = await fetch(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&safesearch=moderate`, {
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const urls = [];
    
    // Bing encodes the image payload inside HTML entity attributes and script tags
    const regex1 = /&quot;murl&quot;:&quot;(https:[^&"]+)&quot;/g;
    const regex2 = /"murl":"(https:[^"]+)"/g;
    
    let match;
    while ((match = regex1.exec(html)) !== null) {
      urls.push(match[1].replace(/\\\//g, '/'));
    }
    while ((match = regex2.exec(html)) !== null) {
      urls.push(match[1].replace(/\\\//g, '/'));
    }
    
    return urls.length > 0 ? [...new Set(urls)] : null;
  } catch (err) {
    return null;
  }
}
