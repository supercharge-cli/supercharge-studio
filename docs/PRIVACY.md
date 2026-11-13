# Crash reports and usage stats

Supercharge Studio can send two kinds of reports. Crash reports are compiled into official
release builds only (builds without the release secrets never send them). Anonymous usage stats
are on in release builds and off in debug builds (see *For maintainers* to turn them off in a build).

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

Sent only when the build includes them and you have not turned them off:

| Event | When | Extra data |
|---|---|---|
| `app_opened` | the app starts | – |
| `update_installed` | the first start after the version changed | `from`: the previous version |
| `session_started` | a new chat session is created (desktop) | – |
| `message_sent` | you sent messages (desktop) | `count`: how many since the last batch, never their text |
| `model_selected` | a model is picked for a chat (desktop), once per model per run | `model` and `provider`: the ids, e.g. `acme/fast-5` |
| `agent_connected` | the app connects to the agent (desktop) or the desktop (phone), once per run | `cli_version` (desktop) |
| `cli_version_detected` | the app finds the installed CLI, once per version per run | `version` |
| `feature_used` | the first use of a feature in a run | a fixed feature name, e.g. `terminal`, `git_commit`, `checkpoint`, `phone_pairing` |
| `error` | the agent connection fails, or an agent error goes unhandled | `kind` (a fixed name) and `code` (a number or short code), never the message |
| `$exception` | an uncaught error in the app (only when crash reports are on too) | the error type and a scrubbed message (as for crash reports) |

Every event also carries `source` (`studio`), `app` (desktop or mobile), `app_version`,
`platform` (desktop, android or ios), `os`, `arch` and a random install id (created on first
start, stored in `telemetry.json` in the app's config folder, and not linked to any account).
Events are anonymous: no person profile is built and no IP-based location is recorded. The
app never puts your IP address in an event, but the stats service may store the IP address the
request arrives from. Ids and versions are checked before sending: anything that looks like a
path, URL, e-mail address or key is dropped, as is every property not listed above.

Chats from the phone run through the desktop app, so the desktop counts them once; the phone
only reports its own start, connection and errors. The headless server never sends usage stats.

Events are queued in memory and sent in one batch about every 30 seconds and when the app
closes (the phone also sends when it leaves the screen). If a batch can't be sent (offline), up
to 200 events are kept in `usage-pending.json` and sent on the next start; failures are silent
and never slow the app. Turning usage stats off deletes everything still queued.

## For maintainers

Release and CI workflows pass these repository secrets to the builds, where they are read at
compile time (`option_env!`):

- `SENTRY_DSN` – crash reports
- `SUPERCHARGE_TELEMETRY_POSTHOG_ENABLED` – usage stats: `false` turns them off in that build,
  `true` turns them on in a debug build (they are on in release builds by default). The project's
  public ingestion key is in `src-tauri/src/telemetry.rs`; optional `SUPERCHARGE_TELEMETRY_POSTHOG_HOST`
  (default `https://us.i.posthog.com`). Forks shipping their own builds should set it to `false`.

A missing `SENTRY_DSN` compiles crash reports out; a feature that is compiled out has no Settings switch.
