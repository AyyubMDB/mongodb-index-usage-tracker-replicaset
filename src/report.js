/**
 * Run this manually after your tracking window (e.g. after 1-2 weeks of the
 * collector running hourly) to see which indexes are genuinely unused.
 *
 * This does NOT drop anything. It only reports. Review the output, then:
 *   1. `collMod` -> hide the candidates for a short burn-in period.
 *   2. If nothing breaks, THEN drop them.
 *
 * The _id_ index is always excluded -- MongoDB won't let you drop or hide
 * it, so there's nothing to decide.
 *
 * Usage: node src/report.js [--json] [--csv]
 *
 * Prefer a visual view? Run `npm run ui` instead for a browser dashboard.
 */

require("dotenv").config();
const { MongoClient } = require("mongodb");
const { buildReport } = require("./lib/report-data");

const MONGODB_URI = process.env.MONGODB_URI;
const MONITOR_DB_NAME = process.env.MONITOR_DB_NAME || "index_usage_monitoring";

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI env var. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();

  try {
    const rows = await buildReport(client, MONITOR_DB_NAME);

    if (rows.length === 0) {
      console.log(
        "No data yet. Let the collector run for a while before generating a report."
      );
      return;
    }

    const printableRows = rows.map((r) => ({
      db: r.db,
      collection: r.collection,
      index: r.index,
      keyPattern: JSON.stringify(r.keyPattern),
      totalOps: r.totalOps,
      pollCount: r.pollCount,
      resetsSeen: r.resetsSeen,
      daysTracked: r.daysTracked,
      flags: r.flags.join("; "),
      recommendation: r.recommendation,
    }));

    const args = process.argv.slice(2);

    if (args.includes("--json")) {
      console.log(JSON.stringify(printableRows, null, 2));
    } else if (args.includes("--csv")) {
      const headers = Object.keys(printableRows[0]);
      console.log(headers.join(","));
      for (const r of printableRows) {
        console.log(
          headers.map((h) => `"${String(r[h]).replace(/"/g, '""')}"`).join(",")
        );
      }
    } else {
      console.table(printableRows);
    }

    const candidates = rows.filter((r) => r.category === "candidate");
    console.log(
      `\n${candidates.length} index(es) flagged as CANDIDATE FOR REMOVAL out of ${rows.length} tracked (excluding _id_).`
    );
    if (candidates.length > 0) {
      console.log(
        "Next step: hide these with collMod, monitor for a week, then drop. See chat notes for the exact commands."
      );
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("Report generation failed:", err);
  process.exit(1);
});
