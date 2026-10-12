# Spond CLI

A small Node.js CLI with no external packages. It reads groups, members, events, and RSVPs through the unofficial Spond API. Requires Node.js **22 or newer**.

## Usage

Run the CLI directly from npm without installing it globally:

```bash
npx --yes @rasifix/spond-cli@latest --help
```

The first run downloads the package into npm's cache. Run published-package examples outside a local `spond-cli` source checkout, because npm otherwise resolves the current project instead of the registry package.

## Commands

```bash
npx --yes @rasifix/spond-cli@latest login
npx --yes @rasifix/spond-cli@latest groups list
npx --yes @rasifix/spond-cli@latest members list --group YOUR_GROUP_ID
npx --yes @rasifix/spond-cli@latest players list --group YOUR_GROUP_ID
npx --yes @rasifix/spond-cli@latest guardians list --group YOUR_GROUP_ID
npx --yes @rasifix/spond-cli@latest events list --group YOUR_GROUP_ID
npx --yes @rasifix/spond-cli@latest events list --group YOUR_GROUP_ID --subgroup YOUR_SUBGROUP_ID
npx --yes @rasifix/spond-cli@latest events rsvp --group YOUR_GROUP_ID --event YOUR_EVENT_ID
npx --yes @rasifix/spond-cli@latest events rsvp --group YOUR_GROUP_ID --subgroup YOUR_SUBGROUP_ID --event YOUR_EVENT_ID
npx --yes @rasifix/spond-cli@latest logout
```

`login` prompts interactively for an email address and password; the password remains hidden. Only the access token and its optional expiration date are stored. MFA/challenge flows and token refresh are not implemented. Run the `npx --yes @rasifix/spond-cli@latest login` command again after the token expires. A failed login does not replace an existing token.

To specify a time range and a higher retrieval limit:

```bash
npx --yes @rasifix/spond-cli@latest events list --group YOUR_GROUP_ID \
  --from 2026-10-01 --to 2026-11-01 --limit 200

npx --yes @rasifix/spond-cli@latest events rsvp --group YOUR_GROUP_ID --event YOUR_EVENT_ID \
  --from 2026-10-01 --to 2026-11-01 --limit 200
```

`groups list` includes both groups and their subgroups. Each row has `id`, `name`, and `parentId`; `parentId` is empty for a group and contains the parent group ID for a subgroup. All group-scoped commands accept `--subgroup`: for `members`, `players`, and `guardians` it restricts the output to members of that subgroup (based on each member's `subGroups`), and for `events` it filters by subgroup. As a shortcut, a subgroup ID from `groups list` may also be passed directly as `--group`.

Dates without a time represent midnight UTC. To use local day boundaries, provide an ISO timestamp with the appropriate offset, for example `2026-10-01T00:00:00+02:00`. Spond determines whether filter boundaries are inclusive or exclusive. Timestamps are output in ISO/UTC format.

For machine-readable output:

```bash
npx --yes @rasifix/spond-cli@latest groups list --json
npx --yes @rasifix/spond-cli@latest members list --group YOUR_GROUP_ID --json
npx --yes @rasifix/spond-cli@latest players list --group YOUR_GROUP_ID --json
npx --yes @rasifix/spond-cli@latest guardians list --group YOUR_GROUP_ID --json
npx --yes @rasifix/spond-cli@latest events list --group YOUR_GROUP_ID --json
npx --yes @rasifix/spond-cli@latest events rsvp --group YOUR_GROUP_ID --event YOUR_EVENT_ID --json
```

JSON output is an array containing the displayed records. RSVP records contain `memberId`, `name`, and `status`. Warnings are written to stderr and data to stdout. Exit codes: 0 for success, 1 for an error, and 130 for an interactive cancellation. A successful list operation may still return incomplete results because of API limits.

## Behavior and limitations

- Groups: ID and name, plus `parentId` for subgroup rows. Members: ID and name.
- Players: members whose Spond `respondent` flag is `true`, with ID and name.
- Guardians: one row per guardian/member relationship with `guardianId`, `name`, `email`, `memberId`, and `memberName`. A guardian of multiple children appears once for each child; identical duplicate relationships are removed. Data comes from `members[].guardians` in the selected group. Missing email addresses are returned as empty strings, while missing guardian lists produce no rows. Restricted visibility may limit the output.
- Events: ID, title, start, and end. The default limit is 100; `--limit` accepts values from 1 to 1000. This is a requested limit, not guaranteed server capacity.
- By default only published, non-hidden events are returned. Add `--include-hidden` and/or `--include-scheduled` to `events list` / `events rsvp` to include hidden events (e.g. events visible only to admins/coaches) and scheduled (not yet published) events. There is no automatic pagination. A warning appears when the requested limit is reached; the CLI cannot detect an unknown, lower server-side limit.
- RSVP data is read from the event in the group event list. No unverified detail endpoint is used. If the event is not found, try again with a narrower time range or a different limit.
- Status values remain `accepted`, `declined`, `unanswered`, `waitinglist`, and `unconfirmed`. RSVP status does not represent observed attendance.
- Missing response fields and unknown ID lists produce notices; conflicting status lists produce an error. Missing lists are not reported as confirmed empty.
- Member names are matched using the group member ID. Unknown IDs remain visible. Organizer responses from `owners` are not reinterpreted as player RSVPs.
- Nothing is written to Spond except what is required for login. There are no automatic retries or background jobs.

## Token storage

The default location is `$XDG_CONFIG_HOME/spond-cli/token.json`, or `~/.config/spond-cli/token.json` when `$XDG_CONFIG_HOME` is not set.
Alternatively, set `SPOND_CONFIG_DIR` to a private directory. On macOS/Linux, the directory is assigned permissions `700` and the token file `600`. The token is **not encrypted**; anyone with access to your user account can read it. On Windows, make sure appropriate user ACLs are configured as well.

`logout` deletes the local token but does not revoke it on the server. The password and email address are not stored. Secrets cannot be passed as CLI arguments. Raw server error responses are not included in the output. JSON output and exported lists may contain personal data.

## Development

From the source checkout, run the CLI directly:

```bash
node bin/spond.js --help
node bin/spond.js login
```

To register the local checkout as the global `spond` command during development:

```bash
npm link
spond --help
```

Run the test suite with:

```bash
npm test
```

Tests cover the HTTP contract with a mock transport, error redaction, RSVP mapping, the token lifecycle and permissions, and argument validation. No live test with a Spond account has been performed. Hidden input is implemented for interactive terminals and should be verified in your terminal during the first login.

Source references, reviewed on October 10, 2026:

- [TypeScript HTTP/login implementation](https://github.com/TSFoster/spond-typescript/blob/main/src/base.ts)
- [TypeScript group/event calls](https://github.com/TSFoster/spond-typescript/blob/main/src/spond.ts)
- [TypeScript data models](https://github.com/TSFoster/spond-typescript/blob/main/src/types.ts)
- [Python RSVP example including unconfirmedIds](https://github.com/Olen/Spond/blob/master/examples/attendance.py)

The API is unofficial. Changes to Spond may require updates to this CLI.
