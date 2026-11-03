/**
 * Shared report-building logic used by both the CLI (report.js) and the
 * web UI (server.js), so the two never drift out of sync.
 *
 * The `_id_` index is deliberately excluded everywhere in this module:
 * MongoDB refuses to drop OR hide the _id index, so there is never an
 * actionable decision to make about it -- showing it in a report meant for
 * decision-making is just noise.
 */

const MIN_POLLS_FOR_CONFIDENCE = Number(process.env.MIN_POLLS_FOR_CONFIDENCE || 100);

async function getIndexMetadata(client, dbName, collectionName) {
  try {
    const indexes = await client
      .db(dbName)
      .collection(collectionName)
      .listIndexes()
      .toArray();
    const map = {};
    for (const idx of indexes) {
      map[idx.name] = {
        unique: !!idx.unique,
        ttl: idx.expireAfterSeconds !== undefined,
        partial: !!idx.partialFilterExpression,
        sparse: !!idx.sparse,
        hidden: !!idx.hidden,
      };
    }
    return map;
  } catch (err) {
    // Collection may have been dropped/renamed since tracking started.
    return null;
  }
}

/**
 * Classifies a single index summary doc into a machine-readable `category`
 * plus a human-readable `recommendation` string and any contextual `flags`.
 *
 * category is one of: "keep" | "too_early" | "do_not_drop" | "review" | "candidate"
 */
function classify(summaryDoc, meta, minPollsForConfidence = MIN_POLLS_FOR_CONFIDENCE) {
  const totalOps = summaryDoc.totalOpsSinceTrackingStarted || 0;
  const pollCount = summaryDoc.pollCount || 0;
  const flags = [];

  if (meta?.hidden) flags.push("already hidden");

  if (totalOps > 0) {
    return { category: "keep", recommendation: "KEEP (in use)", flags };
  }

  // totalOps === 0 from here down.
  if (pollCount < minPollsForConfidence) {
    flags.push(`only ${pollCount} polls so far`);
    return {
      category: "too_early",
      recommendation: "TOO EARLY - keep tracking longer before deciding",
      flags,
    };
  }

  if (meta?.ttl) {
    flags.push("TTL index");
    return {
      category: "do_not_drop",
      recommendation: "DO NOT DROP - TTL index (expires docs, not query-driven)",
      flags,
    };
  }

  if (meta?.unique) {
    flags.push("unique constraint");
    return {
      category: "review",
      recommendation: "REVIEW MANUALLY - enforces uniqueness, verify before dropping",
      flags,
    };
  }

  if (meta?.partial) flags.push("partial index");
  if (meta?.sparse) flags.push("sparse index");

  return {
    category: "candidate",
    recommendation: "CANDIDATE FOR REMOVAL - hide first, monitor, then drop",
    flags,
  };
}

/**
 * Builds the full report row set from the monitoring DB + live index
 * metadata. Returns [] if there's no data yet.
 */
async function buildReport(client, monitorDbName, minPollsForConfidence = MIN_POLLS_FOR_CONFIDENCE) {
  const summaryColl = client.db(monitorDbName).collection("index_usage_summary");

  const summaries = await summaryColl
    .find({ indexName: { $ne: "_id_" } })
    .sort({ db: 1, collection: 1, indexName: 1 })
    .toArray();

  if (summaries.length === 0) {
    return [];
  }

  const metadataCache = new Map();
  const rows = [];

  for (const s of summaries) {
    const cacheKey = `${s.db}.${s.collection}`;
    if (!metadataCache.has(cacheKey)) {
      metadataCache.set(cacheKey, await getIndexMetadata(client, s.db, s.collection));
    }
    const collMeta = metadataCache.get(cacheKey);
    const meta = collMeta ? collMeta[s.indexName] : null;

    const { category, recommendation, flags } = classify(s, meta, minPollsForConfidence);
    const daysTracked =
      (Date.now() - new Date(s.firstSeenAt).getTime()) / 86400000;

    rows.push({
      db: s.db,
      collection: s.collection,
      index: s.indexName,
      keyPattern: s.keyPattern,
      totalOps: s.totalOpsSinceTrackingStarted || 0,
      pollCount: s.pollCount || 0,
      resetsSeen: s.resetCount || 0,
      firstSeenAt: s.firstSeenAt,
      lastSeenAt: s.lastSeenAt,
      daysTracked: Number(daysTracked.toFixed(1)),
      flags,
      category,
      recommendation,
    });
  }

  return rows;
}

module.exports = { getIndexMetadata, classify, buildReport, MIN_POLLS_FOR_CONFIDENCE };
