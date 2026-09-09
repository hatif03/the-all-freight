# Planning flow scaffold (root Next.js app)

Recreate the reference app's planning flow at repo root, swapping the web-search/scrape
provider for a new `src/lib/anakin.ts` (plain REST via fetch, no MCP subprocess).

- Copy config/scaffolding (next.config.ts, tsconfig.json, eslint.config.mjs,
  postcss.config.mjs, public/, globals.css, icon.svg, Dockerfile minus MCP preinstall).
- package.json: drop @brightdata/mcp + @modelcontextprotocol/sdk, rename to the-all-freight.
- New src/lib/anakin.ts replacing brightdata.ts (same shape: search/scrape/mode/searchlog,
  mock fallback dataset ported verbatim).
- Copy remaining src/lib/* with import renames (bdSearch->anakinSearch etc.) and generic
  wording in drivers.ts/types.ts comments.
- Copy src/app/* with generic meta description (no provider name).
- Copy src/components/* with Bright Data -> Anakin badge/labels + new Header nav link to
  a future /ops page (route doesn't exist yet, that's expected).
- .env.example with commented vars.
- Verify: npm install, tsc --noEmit, grep for bright/wayfinder across src/package.json/Dockerfile/.env.example.
- ADR at .agent/records/anakin-web-layer.md; CLAUDE.md updates if needed.
