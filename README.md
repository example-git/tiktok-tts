# TikTok TTS Worker (Cloudflare + VPC)

Cloudflare Worker (`worker/worker.js`) that proxies TikTok text-to-speech. It expects:
- an HTTP endpoint that returns session IDs (supply via `ADMIN_SESSION_API_URL`)
- TikTok API endpoints you provide via `TIKTOK_ENDPOINTS` (array binding) or comma-separated string; no defaults are shipped.

## Setup
- Set `ADMIN_SESSION_API_URL` (and optional auth headers like `ADMIN_SESSION_API_TOKEN`) in your Wrangler config or secrets. The worker uses plain `fetch` to reach it.
- Optional: enable D1 caching by setting `ENABLE_D1_CACHE=true` and binding a D1 database as `SESSION_DB`. Without the flag, D1 is not used.

## Notes
- Session IDs must come from your own endpoint; this repo does not include session data or session-management scripts.
- Keep secrets and session sources out of the repo (`.env`, `.dev.vars`, etc. should be gitignored).
