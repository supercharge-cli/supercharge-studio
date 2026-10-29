# Crash reports and usage stats

Supercharge Studio can send two kinds of reports. Both are compiled into official release
builds only; builds made without the release secrets (local, fork and pull request builds)
contain neither and never send anything.

| | Crash reports | Anonymous usage stats |
|---|---|---|
| Apps | desktop, phone, headless server | desktop, phone |
| Default | on | on |
| Turn off | Settings → *Send crash reports* (server: `--no-crash-reports` or `SCS_CRASH_REPORTS=0`) | Settings → *Send anonymous usage stats* |

`DO_NOT_TRACK=1` or `SUPERCHARGE_TELEMETRY_DISABLED=1` in the environment turns both off for that run.
Turning crash reports off also deletes any reports still waiting to be sent.

## Crash reports

Sent when the app's Rust code panics, or the app's own UI hits an uncaught error or an
unhandled promise rejection. A panic report is written to the app's config folder first
(`crash-pending/`) and sent right away, or on the next start if the app could not send it.
At most 5 reports per run, and each distinct error once.

Each report contains only:

- the error type and message, and for panics the source location inside Studio's own code
  (for example `src/git.rs:120`) and the panic message;
- for UI errors, the stack trace (function names and line numbers in the bundled app script);
- the app (desktop, mobile or server), its version and release, the OS and CPU architecture;
- a random report id and the time.

Before sending, messages and stack traces are scrubbed: file paths and your home folder,
URLs, e-mail addresses, anything that looks like a key, token or secret, and quoted text that
is long or has spaces (where prompts or chat content would appear) are replaced with placeholders,
and the result is truncated. Errors returned by the agent over ACP are reported by their error
code only, since their text can echo a prompt or config. No prompts, chat, code, file names, settings, keys, host names or IP-derived location
are included.

## Usage stats

Sent only when the build enables them and you have not turned them off:

| Event | When | Extra data |
|---|---|---|
| `app_start` | the app starts | – |
| `update_installed` | the first start after the version changed | the previous version |
| `session_start` | a new chat session is created | – |
| `feature_used` | the first use of a feature in a run | a fixed feature name, e.g. `terminal`, `git_commit`, `checkpoint`, `phone_pairing` |

Every event also carries the app, version, OS and architecture and a random install id
(created on first start, stored in `telemetry.json` in the app's config folder, and not linked to
any account). Events are anonymous: no person profile is built and no IP-based location is
recorded. The headless server never sends usage stats.

## For maintainers

Release and CI workflows pass these repository secrets to the builds, where they are read at
compile time (`option_env!`):

- `SENTRY_DSN` – crash reports
- `SUPERCHARGE_TELEMETRY_POSTHOG_API_KEY` and `SUPERCHARGE_TELEMETRY_POSTHOG_ENABLED=true` – usage stats
  (optional `SUPERCHARGE_TELEMETRY_POSTHOG_HOST`, default `https://us.i.posthog.com`)

Missing or empty values compile the feature out; the Settings switches are then hidden.
