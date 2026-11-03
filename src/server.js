/**
 * Local web dashboard for viewing the index usage report.
 *
 * Run: npm run ui
 * Then open http://localhost:4000 (or PORT from .env).
 *
 * Read-only: this never writes to your cluster. It just re-runs the same
 * buildReport() logic as report.js on a timer/on-demand and serves it as
 * JSON to a small static frontend.
 */

require("dotenv").config();
const path = require("path");
const express = require("express");
const { MongoClient } = require("mongodb");
const { buildReport } = require("./lib/report-data");

const MONGODB_URI = process.env.MONGODB_URI;
const MONITOR_DB_NAME = process.env.MONITOR_DB_NAME || "index_usage_monitoring";
const PORT = Number(process.env.UI_PORT || 4000);

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI env var. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();

  const app = express();
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/report", async (req, res) => {
    try {
      const minPolls = req.query.minPolls ? Number(req.query.minPolls) : undefined;
      const rows = await buildReport(client, MONITOR_DB_NAME, minPolls);

      const summary = {
        totalTracked: rows.length,
        keep: rows.filter((r) => r.category === "keep").length,
        candidate: rows.filter((r) => r.category === "candidate").length,
        review: rows.filter((r) => r.category === "review").length,
        doNotDrop: rows.filter((r) => r.category === "do_not_drop").length,
        tooEarly: rows.filter((r) => r.category === "too_early").length,
        oldestTrackingStart: rows.length
          ? rows.reduce(
              (min, r) => (new Date(r.firstSeenAt) < new Date(min) ? r.firstSeenAt : min),
              rows[0].firstSeenAt
            )
          : null,
        lastPolledAt: rows.length
          ? rows.reduce(
              (max, r) => (new Date(r.lastSeenAt) > new Date(max) ? r.lastSeenAt : max),
              rows[0].lastSeenAt
            )
          : null,
      };

      res.json({ generatedAt: new Date().toISOString(), summary, rows });
    } catch (err) {
      console.error("Failed to build report:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`Index usage dashboard running at http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start UI server:", err);
  process.exit(1);
});
