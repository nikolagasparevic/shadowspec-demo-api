# ShadowSpec

ShadowSpec is a behavioral regression testing tool for Fastify + PostgreSQL APIs.

It captures real API behavior and authorized database state, exports deterministic replay scenarios, and replays those scenarios against a guarded target to detect behavioral regressions.

ShadowSpec is designed around a simple rule:

> An unsupported or unsafe replay should fail explicitly rather than produce an incorrect green result.

## Install

```bash
npm install shadowspec
```

ShadowSpec `0.1.x` currently targets:

* Node.js
* Fastify
* PostgreSQL
* JSON APIs

## 1. Create the ShadowSpec capture schema

ShadowSpec ships its capture schema with the npm package.

Apply it to the PostgreSQL database used for ShadowSpec capture storage.

### PowerShell

```powershell
psql $env:DATABASE_URL -f .\node_modules\shadowspec\sql\capture-schema.sql
```

### macOS / Linux

```bash
psql "$DATABASE_URL" -f ./node_modules/shadowspec/sql/capture-schema.sql
```

This creates the ShadowSpec capture tables:

* `api_requests`
* `api_request_snapshots`

along with the indexes and constraints required for atomic capture persistence.

During local development, the application and ShadowSpec capture storage may use the same PostgreSQL database. A separate `capturePool` can also be supplied.

## 2. Register ShadowSpec

```ts
import Fastify from "fastify";
import { Pool } from "pg";
import { registerShadowSpec } from "shadowspec";

const app = Fastify();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

registerShadowSpec(app, {
  applicationPool: pool,
  enabled: true,
  tables: ["orders"],
  privacy: {
    snapshotAllowedColumns: {
      orders: [
        "id",
        "customer_id",
        "product_id",
        "quantity",
        "status"
      ]
    }
  }
});
```

`applicationPool` is the PostgreSQL pool used by the application.

`tables` defines the tables ShadowSpec snapshots before captured requests.

Every configured table must have an explicit `snapshotAllowedColumns` inventory. ShadowSpec refuses capture if the actual database columns do not exactly match the approved set.

Capture failures are fail-open with respect to the host application: ShadowSpec must not change the application's original response.

## 3. Generate traffic

Start the application normally and send requests through it.

For example:

```bash
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"customerId":123,"productId":42,"quantity":2}'
```

ShadowSpec records the request, response, and authorized database state required for deterministic replay.

## 4. Privacy controls

ShadowSpec uses explicit privacy configuration rather than heuristic masking.

Available capture privacy controls include:

* `forbiddenRequestPointers`
* `forbiddenResponsePointers`
* `forbiddenHeaders`
* `snapshotAllowedColumns`

`Authorization` and `Cookie` are forbidden request headers by default.

If a request contains forbidden credentials or a configured forbidden value, ShadowSpec treats that request as uncapturable.

Database snapshot values are only read after the configured column inventory has been validated.

ShadowSpec does not attempt to automatically detect arbitrary PII.

## 5. Export replay scenarios

Set a stable project ID.

The project ID must be a UUID and must remain consistent between export and replay.

### PowerShell

```powershell
$env:SHADOWSPEC_PROJECT_ID="YOUR-PROJECT-UUID"
```

### macOS / Linux

```bash
export SHADOWSPEC_PROJECT_ID="YOUR-PROJECT-UUID"
```

Then export:

```bash
npx shadowspec export
```

A successful export creates:

```text
shadowspec-scenarios.json
```

ShadowSpec only publishes an executable scenario bundle when capture coverage is complete.

Each capture must be explicitly accounted for as executable, excluded, or rejected. Incomplete or ambiguous coverage prevents a false-green export.

Multi-request sessions may be exported as lifecycle scenarios. A one-request session remains a standalone scenario.

## 6. Configure a guarded replay environment

Replay is intentionally disabled by default.

ShadowSpec performs destructive restoration of configured application tables during replay. A replay database must therefore be explicitly authorized before replay can execute.

**Never authorize a production database as a ShadowSpec replay database.**

### 6.1 Create a dedicated replay database

Configure the replay runner to connect to a disposable PostgreSQL database using:

```text
DB_HOST
DB_PORT
DB_USER
DB_PASSWORD
DB_NAME
```

Example:

```powershell
$env:DB_HOST="localhost"
$env:DB_PORT="5432"
$env:DB_USER="shadowspec"
$env:DB_PASSWORD="your-password"
$env:DB_NAME="shadowspec_replay"
```

The replay database must contain the application schema required by the captured scenarios.

### 6.2 Install the replay authorization schema

Apply the replay authorization schema to the replay database:

```powershell
psql -d $env:DB_NAME -f .\node_modules\shadowspec\sql\replay-target-schema.sql
```

This creates:

```text
shadowspec_internal.replay_target
```

ShadowSpec refuses destructive replay if this marker is missing or does not exactly match the current replay configuration.

### 6.3 Create replay identities

Configure:

```text
SHADOWSPEC_PROJECT_ID
SHADOWSPEC_REPLAY_DATABASE_ID
SHADOWSPEC_REPLAY_DATABASE_NAME
SHADOWSPEC_REPLAY_TOKEN
```

Requirements:

* `SHADOWSPEC_PROJECT_ID` must match the project ID used during export.
* `SHADOWSPEC_REPLAY_DATABASE_ID` must be a UUID uniquely identifying the disposable replay database.
* `SHADOWSPEC_REPLAY_DATABASE_NAME` must match the actual PostgreSQL database name.
* `SHADOWSPEC_REPLAY_TOKEN` must contain at least 32 bytes of high-entropy secret material.

Example:

```powershell
$env:SHADOWSPEC_PROJECT_ID="YOUR-PROJECT-UUID"
$env:SHADOWSPEC_REPLAY_DATABASE_ID="YOUR-REPLAY-DATABASE-UUID"
$env:SHADOWSPEC_REPLAY_DATABASE_NAME="shadowspec_replay"
$env:SHADOWSPEC_REPLAY_TOKEN="YOUR-HIGH-ENTROPY-DATABASE-REPLAY-TOKEN"
```

The raw replay token is supplied only to the replay runner. The replay database stores its SHA-256 digest.

On Windows PowerShell, compute the digest with:

```powershell
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$tokenBytes = [System.Text.Encoding]::UTF8.GetBytes(
  $env:SHADOWSPEC_REPLAY_TOKEN
)
$tokenHash = $sha256.ComputeHash($tokenBytes)
$tokenSha256 = (
  $tokenHash |
    ForEach-Object { $_.ToString("x2") }
) -join ""
$sha256.Dispose()
```

The package includes:

```text
node_modules/shadowspec/sql/authorize-replay-target.sql.example
```

as a template for inserting the replay authorization marker.

The marker binds replay authorization to:

* project ID
* replay database ID
* PostgreSQL database name
* SHA-256 digest of the replay token

### 6.4 Enable replay-target identity verification

The candidate API must expose ShadowSpec's protected replay-target handshake endpoint.

Register it:

```ts
import {
  registerShadowSpecReplayTarget
} from "shadowspec";

registerShadowSpecReplayTarget(app);
```

Enable the target:

```text
SHADOWSPEC_REPLAY_TARGET=true
```

and configure:

```text
SHADOWSPEC_PROJECT_ID
SHADOWSPEC_REPLAY_DATABASE_ID
SHADOWSPEC_REPLAY_TARGET_ID
SHADOWSPEC_REPLAY_TARGET_TOKEN
```

`SHADOWSPEC_REPLAY_TARGET_ID` must be a UUID identifying the candidate replay target.

`SHADOWSPEC_REPLAY_TARGET_TOKEN` must be a separate high-entropy secret used only for HTTP replay-target verification.

Do not reuse `SHADOWSPEC_REPLAY_TOKEN`.

The replay-target token itself is not sent over HTTP. ShadowSpec verifies target identity using a nonce-based proof.

### 6.5 Configure the replay runner

The replay runner must connect to the disposable replay database and use the same identities authorized by the database marker and replay target.

Example PowerShell configuration:

```powershell
# PostgreSQL connection used by the replay runner
$env:DB_HOST="localhost"
$env:DB_PORT="5432"
$env:DB_USER="shadowspec"
$env:DB_PASSWORD="your-password"
$env:DB_NAME="shadowspec_replay"

# Explicit destructive-replay opt-in
$env:SHADOWSPEC_REPLAY="true"

# Project and replay database identity
$env:SHADOWSPEC_PROJECT_ID="YOUR-PROJECT-UUID"
$env:SHADOWSPEC_REPLAY_DATABASE_ID="YOUR-REPLAY-DATABASE-UUID"
$env:SHADOWSPEC_REPLAY_DATABASE_NAME="shadowspec_replay"

# Database replay authorization secret
$env:SHADOWSPEC_REPLAY_TOKEN="YOUR-DATABASE-REPLAY-TOKEN"

# Explicit replay mutation scope
$env:SHADOWSPEC_SCHEMA="public"
$env:SHADOWSPEC_TABLES="orders"

# Candidate HTTP target
$env:SHADOWSPEC_TARGET_URL="http://localhost:3000"
$env:SHADOWSPEC_REPLAY_TARGET_ID="YOUR-REPLAY-TARGET-UUID"
$env:SHADOWSPEC_REPLAY_TARGET_TOKEN="YOUR-HTTP-TARGET-TOKEN"
```

`DB_NAME` controls which PostgreSQL database the runner actually connects to.

`SHADOWSPEC_REPLAY_DATABASE_NAME` is independently checked against PostgreSQL's `current_database()` during replay authorization. They must identify the same database.

`SHADOWSPEC_SCHEMA` and `SHADOWSPEC_TABLES` explicitly define the database objects ShadowSpec may restore.

The database replay token and HTTP replay-target token are separate credentials and should never be reused.

### 6.6 Run replay

Start the candidate API against the disposable replay database with replay-target verification enabled.

Then run:

```bash
npx shadowspec replay
```

A successful replay prints a summary similar to:

```text
================================
ShadowSpec Replay Summary
================================
Checks:    8
Passed:    8
Failed:    0
================================
```

ShadowSpec also publishes a structured run result containing fields such as:

```json
{
  "terminalStatus": "passed",
  "plannedChecks": 8,
  "checks": 8,
  "passedChecks": 8,
  "failedChecks": 0
}
```

Before replay work proceeds, ShadowSpec verifies:

1. explicit replay opt-in
2. connected PostgreSQL database identity
3. replay authorization marker
4. project identity
5. replay database identity
6. replay database token
7. explicit replay schema and table scope
8. HTTP replay-target identity
9. replay-target cryptographic proof
10. scenario bundle correlation and coverage completeness

Any mismatch fails closed.

## 7. Purge old capture data

ShadowSpec does not automatically delete historical capture data.

Capture retention is an explicit operator action.

Preview captures older than a number of days:

```bash
npx shadowspec purge --older-than-days 30
```

This is a dry run. No data is deleted.

Example:

```text
ShadowSpec Purge
================
Captures eligible:  142
Snapshots eligible: 142

Dry run only. No data was deleted.
Run again with --yes to delete the eligible captures.
```

To perform the purge:

```bash
npx shadowspec purge --older-than-days 30 --yes
```

Purge is session-aware.

For captures without a `session_id`, eligible old captures may be removed individually.

For captures belonging to a session, ShadowSpec deletes the entire session only when every capture in that session is older than the retention cutoff.

If even one member of a session is newer than the cutoff, the entire session is retained.

This prevents retention from silently changing a multi-step lifecycle into a different replay scenario.

Capture snapshots are removed through the database foreign-key cascade.

The destructive purge operation takes a PostgreSQL table lock while determining and deleting eligible captures so concurrent writes cannot split a session during the purge.

## Capture deadlines

ShadowSpec capture work is bounded so capture infrastructure cannot indefinitely delay the host application.

Relevant environment variables include:

```text
SHADOWSPEC_SNAPSHOT_STATEMENT_TIMEOUT_MS
SHADOWSPEC_SNAPSHOT_TIMEOUT_MS
SHADOWSPEC_RECORDER_TIMEOUT_MS
```

Capture failures remain fail-open with respect to the application response.

## Current limitations

ShadowSpec `0.1.x` intentionally has a narrow scope.

Current limitations include:

* Fastify integration only
* PostgreSQL state capture and replay only
* JSON request and response bodies
* authenticated requests containing `Authorization` or `Cookie` are not capturable
* no automatic arbitrary-PII classifier
* snapshot table column authorization requires an exact configured inventory
* replay does not currently reproduce PostgreSQL sequence allocator state exactly
* generated lifecycle binding inference intentionally supports only conservative patterns
* no automatic retention scheduler
* no KMS-backed secret or capture encryption layer
* no request-header replay beyond ShadowSpec's own replay correlation mechanisms

Unsupported behavior should fail explicitly rather than be silently treated as equivalent.

## Safety model

ShadowSpec separates capture safety from replay safety.

Capture behavior is designed to fail open with respect to the host API: a ShadowSpec capture failure must not change the application's response.

Privacy and replay correctness fail closed: ShadowSpec refuses persistence or replay when required safety invariants cannot be proven.

Replay should only be run against disposable, explicitly authorized infrastructure.

## Development

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

Real PostgreSQL integration tests can be enabled with:

```powershe
```
