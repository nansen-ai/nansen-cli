---
"nansen-cli": minor
---

Add `--paginate` (alias `--all`) to fetch every page of a list-returning command in one call (API-275). Starts at `--page`, uses `--limit` as the page size, and stops on a short or empty page, on server completion metadata, on a repeated page, or after `--max-pages` requests (default 10, maximum 1000). The merged response keeps the first page's shape with rows de-duplicated and adds `pagination: { page, pages_fetched, next_page, complete }`; `next_page` tells you where to resume when the cap was hit, and the stderr credit summary totals live page requests. Default single-page behaviour is unchanged.
