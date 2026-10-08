// New searches (cache misses) allowed per IP per day, reset at 00:00 UTC. Cache hits never count.
// Safe to edit by hand. Imported by the worker and by the homepage (as a static file, so no Functions quota);
// README.md needs a manual update.
// The burst limit (~10 req/10s) is a Cloudflare WAF rule, not set here.
export const DAILY_LIMIT = 25;
export const FREE_DAILY_LIMIT = 100;
