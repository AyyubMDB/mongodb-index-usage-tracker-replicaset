/**
 * Index usage collector.
 *
 * Run this hourly via cron (see setup notes). Each run:
 *   1. Auto-discovers every node in the replica set from your existing
 *      mongodb+srv:// connection string (via DNS SRV/TXT lookup) and opens a
 *      DIRECT connection to each one individually (directConnection=true).
 *      This is deliberate: relying on readPreference (e.g. primaryPreferred)
 *      only samples ONE node per poll, and which node that is can silently
 *      change between polls (elections, cluster pause/resume, other clients
 *      like Compass reading from a secondary). If the node serving real
 *      traffic and the node the collector happens to reach diverge, usage
 *      gets missed entirely. Polling all nodes every run eliminates that
 *      blind spot regardless of which node(s) actually served queries.
 *   2. Enumerates every application database/collection (skips system DBs
 *      and the monitoring DB itself).
 *   3. Runs `{ $indexStats: {} }` per collection, once per node.
 *   4. Writes a raw sample per (index, node) into a time-series collection.
 *   5. Updates a reset-aware cumulative summary per index, so that a
 *      restart/election (which zeroes $indexStats.accesses.ops on that node)
 *      never silently erases history. Resets are detected via the
 *      `accesses.since` timestamp changing, not just the ops value dropping.
 *
 * Safe to run concurrently across multiple invocations only if you avoid
 * overlap (see the flock example in the cron setup notes) -- the summary
 * update is read-then-write, not atomic, and assumes single-writer.
 */

require("dotenv").config();
const dns = require("dns").promises;
const { MongoClient, Long } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI;
const MONITOR_DB_NAME = process.env.MONITOR_DB_NAME || "index_usage_monitoring";
const RAW_COLLECTION = "index_usage_raw";
const SUMMARY_COLLECTION = "index_usage_summary";

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI env var. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const EXCLUDED_DATABASES = new Set(["admin", "local", "config", MONITOR_DB_NAME]);

function toNumberSafe(value) {
  if (value == null) return 0;
  if (Long.isLong(value)) return value.toNumber();
  if (typeof value === "number") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Mongo doesn't allow "." in a field name used as a nested path segment
// reliably across all drivers/versions, so sanitize host keys used in
// dot-notation update paths (e.g. perHost.<host>).
function sanitizeHostKey(host) {
  return String(host).replace(/\./g, "_").replace(/\$/g, "_");
}

/**
 * Given a mongodb+srv:// URI, resolve the individual node hostnames via DNS
 * (the same mechanism the driver itself uses under the hood for SRV
 * discovery) and build one direct-connection URI per node.
 *
 * Falls back to returning [originalUri] unchanged if the URI isn't a
 * mongodb+srv:// URI (e.g. you're already using a standard connection
 * string with explicit hosts) -- in that case only a single connection is
 * used, same as before.
 */
async function resolveDirectNodeUris(uri) {
  const srvMatch = uri.match(/^mongodb\+srv:\/\/([^@]+)@([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!srvMatch) {
    return [uri];
  }

  const [, userInfo, clusterAddress, , queryString] = srvMatch;
  const restParams = new URLSearchParams(queryString ? queryString.slice(1) : "");
  restParams.delete("directConnection");

  let authSource = restParams.get("authSource") || "admin";
  restParams.delete("authSource");

  // Atlas publishes a TXT record with authSource / replicaSet hints for SRV
  // connection strings. We only need authSource here -- replicaSet is
  // deliberately dropped because it conflicts with directConnection=true.
  try {
    const txtRecords = await dns.resolveTxt(clusterAddress);
    const txtParams = new URLSearchParams(txtRecords.map((r) => r.join("")).join("&"));
    if (txtParams.get("authSource")) {
      authSource = txtParams.get("authSource");
    }
  } catch (err) {
    // No TXT record found; proceed with the default/explicit authSource.
  }

  const srvRecords = await dns.resolveSrv(`_mongodb._tcp.${clusterAddress}`);
  if (srvRecords.length === 0) {
    throw new Error(`No SRV records found for ${clusterAddress}`);
  }

  restParams.set("authSource", authSource);
  restParams.set("tls", "true");
  restParams.set("directConnection", "true");

  return srvRecords.map(
    (rec) => `mongodb://${userInfo}@${rec.name}:${rec.port}/?${restParams.toString()}`
  );
}

async function ensureRawTimeSeriesCollection(monitorDb) {
  const existing = await monitorDb
    .listCollections({ name: RAW_COLLECTION })
    .toArray();
  if (existing.length > 0) return;

  await monitorDb.createCollection(RAW_COLLECTION, {
    timeseries: {
      timeField: "timestamp",
      metaField: "metadata",
      granularity: "hours",
    },
  });
  console.log(`Created time-series collection "${RAW_COLLECTION}".`);
}

async function ensureSummaryIndexes(monitorDb) {
  const summaryColl = monitorDb.collection(SUMMARY_COLLECTION);
  await summaryColl.createIndex({ db: 1, collection: 1 });
  await summaryColl.createIndex({ totalOpsSinceTrackingStarted: 1 });
}

async function getAppDatabaseNames(client) {
  const admin = client.db().admin();
  const { databases } = await admin.listDatabases({ nameOnly: true });
  return databases
    .map((d) => d.name)
    .filter((name) => !EXCLUDED_DATABASES.has(name));
}

async function getScannableCollections(db) {
  const infos = await db.listCollections({}, { nameOnly: false }).toArray();
  return infos.filter(
    (info) => info.type !== "view" && !info.name.startsWith("system.")
  );
}

async function getIndexStats(db, collectionName, nodeLabel) {
  try {
    return await db
      .collection(collectionName)
      .aggregate([{ $indexStats: {} }])
      .toArray();
  } catch (err) {
    console.error(
      `  ! $indexStats failed on ${db.databaseName}.${collectionName} (${nodeLabel}): ${err.message}`
    );
    return [];
  }
}

/**
 * Reset-aware delta computation for a single (index, host) counter.
 * Mirrors how Prometheus/monitoring systems handle monotonic counters that
 * can reset to zero (process restart / index rebuild).
 */
function computeDelta(existingPerHostEntry, currentOps, currentSinceMs) {
  if (!existingPerHostEntry) {
    // First time we've ever seen this (index, host) pair. Count everything
    // accumulated so far as "known usage" -- for the purpose of "was this
    // index ever used", that's the correct behavior.
    return { delta: currentOps, wasReset: false };
  }

  const prevSinceMs = new Date(existingPerHostEntry.lastSince).getTime();
  const prevOps = existingPerHostEntry.lastOps;

  const counterReset = currentSinceMs !== prevSinceMs || currentOps < prevOps;
  if (counterReset) {
    return { delta: currentOps, wasReset: true };
  }

  return { delta: currentOps - prevOps, wasReset: false };
}

async function upsertSummary(summaryColl, sample, now) {
  const { summaryKey, db, collection, indexName, keyPattern, host, ops, since } =
    sample;
  const sinceMs = new Date(since).getTime();
  const hostKey = sanitizeHostKey(host);

  const existing = await summaryColl.findOne(
    { _id: summaryKey },
    { projection: { [`perHost.${hostKey}`]: 1 } }
  );
  const existingPerHostEntry = existing?.perHost?.[hostKey] || null;

  const { delta, wasReset } = computeDelta(existingPerHostEntry, ops, sinceMs);

  const update = {
    $set: {
      db,
      collection,
      indexName,
      keyPattern,
      lastSeenAt: now,
      [`perHost.${hostKey}`]: {
        host,
        lastOps: ops,
        lastSince: since,
        lastPolledAt: now,
      },
    },
    $inc: {
      totalOpsSinceTrackingStarted: delta,
      pollCount: 1,
      ...(wasReset ? { resetCount: 1 } : {}),
    },
    $setOnInsert: {
      firstSeenAt: now,
    },
  };

  // Audit trail only -- does NOT feed into the total. Records exactly what
  // got folded into totalOpsSinceTrackingStarted right before each detected
  // reset, so the cumulative number can be verified/traced later instead of
  // just trusted. Capped at the most recent 50 entries per index so this
  // doesn't grow unbounded over months of tracking.
  if (wasReset && existingPerHostEntry) {
    update.$push = {
      resetHistory: {
        $each: [
          {
            host,
            detectedAt: now,
            opsCapturedBeforeReset: existingPerHostEntry.lastOps,
            previousSince: existingPerHostEntry.lastSince,
            newSince: since,
          },
        ],
        $slice: -50,
      },
    };
  }

  await summaryColl.updateOne({ _id: summaryKey }, update, { upsert: true });
}

async function pollNode(nodeUri, nodeLabel, dbNames, rawColl, summaryColl, now) {
  const client = new MongoClient(nodeUri, {
    readPreference: "secondaryPreferred", // node's own role doesn't matter, we're direct-connected
    serverSelectionTimeoutMS: 10000,
  });

  const rawDocs = [];
  let indexSampleCount = 0;
  let collectionCount = 0;

  try {
    await client.connect();

    for (const dbName of dbNames) {
      const db = client.db(dbName);
      const collections = await getScannableCollections(db);

      for (const collInfo of collections) {
        collectionCount += 1;
        const stats = await getIndexStats(db, collInfo.name, nodeLabel);

        for (const stat of stats) {
          const host = stat.host || nodeLabel;
          const ops = toNumberSafe(stat.accesses?.ops);
          const since = stat.accesses?.since || now;

          rawDocs.push({
            timestamp: now,
            metadata: {
              host,
              db: dbName,
              collection: collInfo.name,
              indexName: stat.name,
              keyPattern: stat.key,
            },
            ops,
            since,
          });

          await upsertSummary(
            summaryColl,
            {
              summaryKey: `${dbName}.${collInfo.name}.${stat.name}`,
              db: dbName,
              collection: collInfo.name,
              indexName: stat.name,
              keyPattern: stat.key,
              host,
              ops,
              since,
            },
            now
          );

          indexSampleCount += 1;
        }
      }
    }

    if (rawDocs.length > 0) {
      await rawColl.insertMany(rawDocs);
    }

    console.log(
      `  - ${nodeLabel}: OK - ${collectionCount} collection(s), ${indexSampleCount} index sample(s).`
    );
    return { ok: true, collectionCount, indexSampleCount };
  } catch (err) {
    console.error(`  - ${nodeLabel}: FAILED - ${err.message}`);
    return { ok: false, collectionCount: 0, indexSampleCount: 0 };
  } finally {
    await client.close();
  }
}

async function main() {
  const now = new Date();

  const nodeUris = await resolveDirectNodeUris(MONGODB_URI);
  console.log(`[${now.toISOString()}] Discovered ${nodeUris.length} node(s) to poll.`);

  // IMPORTANT: writes (raw inserts + summary upserts) go through the normal,
  // topology-aware SRV client -- NOT a direct-to-one-node connection --
  // so the driver automatically routes writes to whichever node is
  // currently primary. Only *reading* $indexStats needs direct per-node
  // connections (see pollNode), since that's node-local diagnostic data.
  const writerClient = new MongoClient(MONGODB_URI, {
    readPreference: "primary",
  });
  await writerClient.connect();

  try {
    const dbNames = await getAppDatabaseNames(writerClient);

    const monitorDb = writerClient.db(MONITOR_DB_NAME);
    await ensureRawTimeSeriesCollection(monitorDb);
    await ensureSummaryIndexes(monitorDb);

    const rawCollection = monitorDb.collection(RAW_COLLECTION);
    const summaryCollection = monitorDb.collection(SUMMARY_COLLECTION);

    let totalSamples = 0;
    let failedNodes = 0;

    for (let i = 0; i < nodeUris.length; i += 1) {
      const nodeLabel = `node-${i + 1}`;
      const result = await pollNode(
        nodeUris[i],
        nodeLabel,
        dbNames,
        rawCollection,
        summaryCollection,
        now
      );
      if (!result.ok) failedNodes += 1;
      totalSamples += result.indexSampleCount;
    }

    console.log(
      `[${now.toISOString()}] DONE - polled ${dbNames.length} db(s) across ` +
        `${nodeUris.length} node(s) (${failedNodes} failed), ${totalSamples} total index sample(s) recorded.`
    );
  } finally {
    await writerClient.close();
  }
}

main().catch((err) => {
  console.error("Collector run failed:", err);
  process.exit(1);
});
