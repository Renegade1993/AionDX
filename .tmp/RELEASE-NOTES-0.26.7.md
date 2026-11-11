## AionDX 0.26.7 (beta)

The prompt cache is now measured, not assumed.

### Why
Anthropic decides how long a Claude chat's prompt cache lasts, and it changed on its side: on this developer's PC every chat wrote
5-minute cache entries until October 12th, 2026 and 1-hour entries from then on, with the same Claude Code build. AionDX counted
5 minutes from a chat's last message, so the Loop put a lane to rest as cold when its nudge was held up a few minutes (team send
spacing, a draft, a minute after your message) while its cache was still warm for most of an hour, and that lane's next turn paid to
write the whole context again.

### What changed
- The Claude launcher's usage tap reads the first event of every answer to a chat's main conversation (subagent and helper calls are
  left out by the headers Claude Code sends) and records how long the cache it wrote lasts and when it runs out. The answer itself
  reaches Claude untouched.
- The Loop counts from that record: it rests a lane only when its cache has run out, keeps it warm with one nudge 6 minutes before an
  hour cache ends, and spaces nudges after short replies at 2, 4, 8, 15 and 30 minutes, never past that point. A chat with no record
  keeps the 5-minute counting.
- The context ring's snowflake shows only when the record says the cache is gone, and its hover line gives the last call and how long
  it kept the cache, plus the last time the cache had to be rebuilt. A chat with no record shows no cache state.

Tests: launcher 60 (12 new), click suite with a new Loop scenario and the snowflake block rewritten, live suites on the built app.
