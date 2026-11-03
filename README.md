# MongoDB Index Usage Tracker

A lightweight tool that tracks how often each index on your MongoDB Atlas
replica set is actually used — reliably, over days or weeks, even across
primary elections and node restarts — so you can confidently identify
indexes that are safe to remove.

## Why this exists

MongoDB Atlas can already show you index usage stats via `$indexStats`, but
that data lives **per node**, not per cluster, and it **resets** whenever a
node restarts or a primary election happens (routine maintenance, patching,
scaling events). In practice this means:

- An index that looks "unused" in the Atlas UI right now might just be
  unused _since the last restart_ — it could have years of real usage
  history that's now invisible.
- Querying through the normal connection string only reaches whichever node
  the driver currently considers primary — if a different node served real
  traffic earlier (e.g. the previous primary, before an election), that
  usage is invisible to a single query.

This tool solves both problems by polling **every node in the replica set
directly** on a schedule, and maintaining a running total that survives
resets — so after a tracking period, you get a trustworthy answer to "has
this index actually been used at all," not just "was it used since the
last time something restarted."

It never modifies or deletes anything on your cluster. It only reads
`$indexStats` and writes to its own small tracking collection.

## What you get

- A **report** (command line or web dashboard) listing every index across
  every database, classified as:
  - **Keep (in use)** — has recorded usage, leave it alone.
  - **Candidate for removal** — zero recorded usage over the tracking
    window, safe to consider dropping (after the safety steps below).
  - **Review manually** — zero recorded query usage, but enforces a unique
    constraint; verify before touching.
  - **Do not drop (TTL)** — a TTL index; these expire documents rather than
    serve queries, so zero query usage is expected and normal.
  - **Too early** — not enough tracking data yet to draw a conclusion.
- A full audit trail: every time a node's counter resets (restart,
  election), it's logged with a timestamp and exactly how much usage was
  captured right before the reset — so the final numbers are traceable, not
  just trusted.

## How it works (brief technical overview)

1. **`collector.js`** runs on a schedule (hourly is the default
   recommendation) and:
   - Auto-discovers every node in the replica set directly from your
     existing connection string (via DNS SRV/TXT lookup — the same
     mechanism the MongoDB driver itself uses) and connects to each one
     individually, rather than relying on the driver's automatic routing
     (which only reaches one node per query, and silently changes which
     one after an election).
   - Runs `{ $indexStats: {} }` against every collection, once per node.
   - Records a running, reset-aware cumulative total per index — a restart
     or election never silently erases history, it's detected (via the
     `accesses.since` timestamp changing) and handled explicitly.
2. **`report.js`** / the web dashboard (**`npm run ui`**) read that tracked
   data at any time and classify every index as above. Nothing here writes
   to your application databases — only to its own small tracking database.

## Data this tool stores on your cluster

This tool creates exactly one new database (`index_usage_monitoring` by
default, configurable via `MONITOR_DB_NAME`) containing two collections.
Nothing else on your cluster is ever written to — every other interaction
is read-only (`$indexStats`, `listIndexes`, `listDatabases`).

### `index_usage_raw` (time-series collection)

One document per index per node per poll — the raw, per-node samples the
collector records every run. Kept mainly as an audit trail; the report
reads from `index_usage_summary` below, not from this collection.

```json
{
  "_id": ObjectId("..."),
  "timestamp": ISODate("2026-08-26T12:00:00.000Z"),
  "metadata": {
    "host": "cluster-shard-00-01.xxxxx.mongodb.net:27017",
    "db": "orders_db",
    "collection": "orders",
    "indexName": "customerId_1",
    "keyPattern": { "customerId": 1 }
  },
  "ops": 184,
  "since": ISODate("2026-08-20T03:15:42.000Z")
}
```

### `index_usage_summary`

One document per index, updated on every poll — the reset-aware cumulative
total this tool exists to produce, a small per-node bookkeeping cache used
to compute that total correctly, and an audit trail of every detected
reset (so the final number is traceable, not just trusted).

```json
{
  "_id": "orders_db.orders.customerId_1",
  "db": "orders_db",
  "collection": "orders",
  "indexName": "customerId_1",
  "keyPattern": { "customerId": 1 },
  "firstSeenAt": ISODate("2026-08-01T09:00:00.000Z"),
  "lastSeenAt": ISODate("2026-08-26T12:00:00.000Z"),
  "totalOpsSinceTrackingStarted": 4820,
  "pollCount": 312,
  "resetCount": 2,
  "perHost": {
    "cluster-shard-00-00_xxxxx_mongodb_net:27017": {
      "host": "cluster-shard-00-00.xxxxx.mongodb.net:27017",
      "lastOps": 184,
      "lastSince": ISODate("2026-08-20T03:15:42.000Z"),
      "lastPolledAt": ISODate("2026-08-26T12:00:00.000Z")
    }
  },
  "resetHistory": [
    {
      "host": "cluster-shard-00-00.xxxxx.mongodb.net:27017",
      "detectedAt": ISODate("2026-08-20T03:15:00.000Z"),
      "opsCapturedBeforeReset": 3120,
      "previousSince": ISODate("2026-08-10T00:00:00.000Z"),
      "newSince": ISODate("2026-08-20T03:15:42.000Z")
    }
  ]
}
```

`totalOpsSinceTrackingStarted` is what ultimately drives the
keep/candidate/review/do-not-drop classification in the report.

## Prerequisites

- A machine that can run Node.js 18+ (either an existing app server, or
  even a laptop for a quick ad-hoc check — see "Running it" below)
- Network access from that machine to the cluster (standard Atlas IP
  Access List entry — no VPN/peering changes needed)
- A dedicated, limited-privilege database user (created below) — this tool
  never needs write access to your application data, only read access plus
  write access to its own tracking database

## Setup

### 1. Create a dedicated monitoring database user

In `mongosh` (connected as an admin) or via the Atlas UI → **Database
Access** → **Add New Database User**:

```js
db.getSiblingDB("admin").createUser({
  user: "index_usage_monitor",
  pwd: "<choose-a-strong-password>",
  roles: [
    { role: "clusterMonitor", db: "admin" },
    { role: "readAnyDatabase", db: "admin" },
    { role: "readWrite", db: "index_usage_monitoring" },
  ],
});
```

This user can read everywhere and write only to its own
`index_usage_monitoring` database — it cannot modify or delete anything in
your application data.

### 2. Add the running machine's IP to Atlas Network Access

Atlas UI → **Network Access** → **Add IP Address**.

### 3. Install

```bash
npm install
```

### 4. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```
MONGODB_URI=mongodb+srv://index_usage_monitor:<password>@<your-cluster>.mongodb.net/?retryWrites=true&w=majority
MONITOR_DB_NAME=index_usage_monitoring
MIN_POLLS_FOR_CONFIDENCE=100
```

`MONGODB_URI` is the cluster's normal connection string — the same kind of
string an application would use. `MONITOR_DB_NAME` is created
automatically on first run; nothing to set up manually.

## Running it

You have two options — pick whichever fits your infrastructure. Both do
exactly the same thing; the only difference is where/how often it runs.

### Option A: Scheduled via cron on an app server (recommended)

Best if you have any existing always-on Linux server or container where a
small scheduled job can live.

```bash
crontab -e
```

Add (adjust the path; the `flock` guard prevents overlapping runs if a poll
ever takes longer than an hour):

```
0 * * * * /usr/bin/flock -n /tmp/idx-collector.lock node /path/to/this/project/src/collector.js >> /var/log/idx-collector.log 2>&1
```

This polls once per hour, continuously, with no manual intervention needed.
Let it run for the recommended tracking window (see below), then generate
the report whenever convenient.

### Option B: Run manually from a local machine

If you'd rather not set up a scheduled job right away, you can simply run
it by hand whenever convenient:

```bash
node src/collector.js
```

Each run polls once and exits — printing a summary like:

```
[timestamp] Discovered 3 node(s) to poll.
  - node-1: OK - 42 collection(s), 97 index sample(s).
  - node-2: OK - 42 collection(s), 97 index sample(s).
  - node-3: OK - 42 collection(s), 97 index sample(s).
[timestamp] DONE - polled N db(s) across 3 node(s) (0 failed), 291 total index sample(s) recorded.
```

The tradeoff: usage data only gets captured at the moments you happen to
run it, so you'll build a less complete picture than an always-on hourly
cron job — but it's a fine way to get started immediately, or to do a
quick spot-check, without needing a server set up first. You can always
switch to Option A later; both write to the same tracking data.

## Viewing results

### Command line

```bash
node src/report.js            # table view
node src/report.js --csv > index_usage_report.csv
node src/report.js --json
```

### Web dashboard

```bash
npm run ui
```

Then open `http://localhost:4000` in a browser (or whatever `UI_PORT` is
set to). It shows summary cards (candidates for removal / review manually
/ do-not-drop / too-early / keep), lets you search, filter by database or
recommendation, sort any column, and export the currently-filtered view to
CSV. Click "Refresh" after the collector has run again to see updated
numbers. This is read-only and never writes to your cluster.

![Index usage report dashboard](./screenshots/dashboard-report.png)
*Placeholder — insert a screenshot of the dashboard here.*

### Debugging a specific index

```bash
node src/diagnose.js <database> <collection> <indexName>
```

Dumps live `$indexStats` from every node individually, plus the current
summary document and full raw sample history for that index — useful if
any number ever looks surprising and you want to see exactly where it
came from.

## How long to track before deciding

We recommend tracking for **at least 3–4 weeks** before treating a
"candidate for removal" as final. If any part of your business has
month-end, quarter-end, or other periodic batch/reporting jobs that only
touch certain indexes occasionally, extend the window to cover at least one
full cycle — an index that's silent for two weeks could still be load-
bearing on day 30.

## Before you drop anything

This tool never deletes anything automatically, and we don't recommend
dropping a "candidate" index directly either. For each one:

```js
// 1. Hide it first -- reversible, no rebuild needed to undo
db.collection.hideIndex("indexName");

// 2. Monitor application/query performance for about a week

// 3. If nothing broke, drop it for real
db.collection.dropIndex("indexName");
```

Hiding an index makes MongoDB stop considering it for queries without
actually removing it — if something unexpected breaks, un-hiding is
instant. Dropping is the only step that requires a rebuild to undo, so
treat it as the final, deliberate step, not the first one.

Note also that `_id_` (the default index every collection has) never
appears in the report — MongoDB doesn't allow dropping or hiding it, so
there's nothing to decide about it.

## Troubleshooting

- **`MongoServerError: bad auth`** — check the password in `.env` and that
  the user was created on the `admin` database.
- **Connection timeout** — check that the running machine's IP is in Atlas
  Network Access.
- **A specific node's log line says `FAILED`** — usually a temporary
  network blip or that node being down during an election. As long as
  other nodes still succeed, no data is lost.
- **`$indexStats failed on <db>.<coll>` for some nodes but not others** —
  check the error message; usually a transient connectivity issue to that
  specific node.
- **Everything shows `TOO EARLY`** — normal early on; wait for more polls
  to accumulate (governed by `MIN_POLLS_FOR_CONFIDENCE` in `.env`).

## Questions

Reach out to [Your Name / Your Company] with any questions about setup,
results, or before acting on any specific recommendation.
