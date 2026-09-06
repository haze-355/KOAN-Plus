# Data refresh strategy

[Back to README](../README.en.md) · [日本語](./sync-policy.md)

Technical reference. For everyday use, see the refresh guidance in the README.

KOAN Plus uses separate cache lifetimes for frequently changing information and
expensive synchronization tasks.

- With auto-login enabled, startup, navigation, focus, reconnection, and a local
  30-second freshness check refresh only expired data. The local check itself
  sends no university requests. Hidden and offline pages start no automatic sync.
- Manual refresh reuses the last minute of recent bulletin, current class-change,
  CLE assignment-list, and message data while preserving longer-lived caches.
  Deferred requests retry automatically while visible and online. Web Locks
  serialize synchronization across tabs; completed cache writes are shared.
- Concurrent KOAN portal authentication checks share an active request. CLE
  readiness checks do the same for each tab. Completed authentication results
  are not cached.
- Each service retains the ID of its extension-owned authentication tab in
  browser session storage. Retries after a polling timeout or background restart
  reuse that tab without navigating away from an unfinished OTP form. Closed
  tabs or tabs moved to unrelated sites are replaced; successful authentication
  releases ownership. Polling deadlines and synchronization backoff are unchanged.
- KOAN checks the current login state immediately. While awaiting login, it
  checks the portal every five seconds for up to 90 seconds. Completion may be
  detected up to approximately four seconds later than with the previous
  one-second interval. Local tab-close checks still run every second. Academic
  data refresh intervals and CLE authentication polling are unchanged.
- Dashboard refresh fetches only the categories whose cache lifetime has expired.
- KOAN refreshes reuse category caches: this week's class changes and unread
  bulletins use a short interval, survey listings and the current schedule use
  a medium interval, schedule and class-change pages up to eight weeks ahead
  use a six-hour cache, and course registration mappings are refreshed daily.
- CLE refreshes reuse cached data by category. Message summaries normally use a
  15-minute cache, assignment lists 10 minutes, and course mappings 24 hours.
  Assignment status enrichment uses status-aware intervals because it costs
  additional per-assignment requests.
- CLE assignment status enrichment prioritizes nearby unfinished assignments.
  Normal refreshes inspect assignments due between 30 days ago and 14 days
  ahead, plus assignments without a due date. Submitted work remains eligible
  outside this window so posted grades can be detected. Graded,
  submitted, and expired items are rechecked after seven days, six hours, and
  24 hours respectively. The cache is not marked complete while eligible
  assignment statuses remain unchecked.
- CLE announcements are fetched progressively for currently enrolled courses.
  The selected and recently used courses are prioritized, with at most four
  courses fetched per refresh and a separate two-hour cache per course.
  Remaining courses continue on later refreshes.
- Bulletin snapshots use a six-hour cache for automatic and manual updates. The
  first run builds the snapshot; later runs stop paging per genre after two
  consecutive pages contain only previously known bulletins. Hitting a page
  limit leaves the snapshot marked partial. Resuming skips recently completed
  genres in the current cache format.
- Bulletin bodies are not prefetched because opening a detail page may change
  unread state.
- Expired cached data remains visible while refreshes run. Identical in-flight
  URL requests are shared, and repeated failures use per-target exponential
  backoff. Unexpected response shapes and incomplete pagination preserve the
  previous cache and are reported as partial refreshes instead of empty data.
- Grades refresh automatically on a six-hour cache lifetime, even without opening
  the grades page. Manual updates reuse the last minute of results. Authentication
  and fetch failures preserve saved data and use increasing retry delays.

Bulletin crawls retain page, runtime, and request-gap limits. Disabling auto-login
also stops periodic automatic synchronization; manual refresh remains available.

When a bulletin crawl hits its time limit or encounters a network or page-shape
failure, it retains bulletins already parsed and completed genres while marking
the snapshot partial. Retries can skip completed genres; unfinished genres still
start at their first page. Schedule and bulletin crawls do not request a page
that would be discarded immediately after reaching the traversal limit.

## Explicit retries

A user-initiated retry can resume one minute after the previous attempt. Automatic retries retain increasing delays after failures. Both retain cross-tab exclusion and resource-specific request limits.

See [sync.ts](../src/sync.ts), [koan.ts](../src/koan.ts), and [cle.ts](../src/cle.ts).
