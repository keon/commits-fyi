# GitHub City Rankings

Static leaderboard of top GitHub users, organizations, and repositories per city.
Data is refreshed daily by GitHub Actions and served via GitHub Pages.

## How it works

1. `scripts/fetch.mjs` runs in [GitHub Actions on a daily cron](./.github/workflows/refresh.yml).
   For each city it:
   - Searches GitHub for users + orgs whose self-reported `location` matches the city
   - Sorts by follower count
   - Pulls each account's public non-fork repos and sums stargazers
   - Writes a static `data/<slug>.json`
2. The workflow commits the updated JSON.
3. A second workflow ([deploy.yml](./.github/workflows/deploy.yml)) publishes the repo to GitHub Pages on every push.
4. `index.html` loads `data/index.json` + `data/<slug>.json` directly — no API calls in the browser, no rate limits, instant load.

No PAT needed — the cron uses the auto-provided `GITHUB_TOKEN`.

## Adding a city

Edit the `CITIES` array at the top of `scripts/fetch.mjs` and either wait for the cron or trigger
`workflow_dispatch` from the Actions tab with the new city name.

## Local dev

```bash
# Bootstrap data locally (needs a personal token)
GH_TOKEN=ghp_xxx node scripts/fetch.mjs "New York"

# Serve the site
python3 -m http.server 8000
open http://localhost:8000
```

## Caveats

GitHub location is free-text and self-reported. `New York` won't match users who wrote `NYC`,
`Brooklyn`, or left it blank. Rankings are "top discoverable users by location string" — not
"top developers in the city."
