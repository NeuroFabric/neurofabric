feat(agent): the chat-first pivot

Phase 5. The Owner's screenshot showed two things wrong with the product, and
only one of them was the CSP.

## TASK 1 -- the charts must render

The CSP was innocent. `script-src` already named unpkg. The page was asking
unpkg for `chart.js@4.4.1/dist/chart.umd.min.js`, and Chart.js v4 ships no such
file -- the `min` suffix is a v3 convention. Verified against the live CDN by
hand; the old URL returns 404.

The policy is now built once, shipped as a real HTTP header as well as a meta
tag, and the two are asserted identical. Unifying them surfaced a second defect:
the meta tag carried `style-src` twice, and duplicate CSP directives are
discarded.

## TASK 2 -- the semantic profiler

The engine reads headers, types and structure BEFORE any statistics, and states
what it believes the file IS. A file with `query_snippet` and
`total_elapsed_time_ms` is a database performance log; `customer_id` and
`purchase_amount` is a transaction record; `request_path` and `status_code` is a
web access log.

## TASK 3 -- chat-first

The conversation is the product. The analysis arrives as widgets IN the
conversation, in answer to questions, rather than as a dashboard the user must
learn to navigate.

## Kernel

FROZEN. Nothing under platform/core/ touched.