const CATEGORY_LABELS = {
  keep: "Keep (in use)",
  candidate: "Candidate for removal",
  review: "Review manually",
  do_not_drop: "Do not drop (TTL)",
  too_early: "Too early",
};

let allRows = [];
let sortKey = "totalOps";
let sortDir = "asc";

async function loadReport() {
  const subtitle = document.getElementById("subtitle");
  subtitle.textContent = "Loading\u2026";

  try {
    const res = await fetch("/api/report");
    const data = await res.json();

    if (data.error) {
      subtitle.textContent = `Error: ${data.error}`;
      return;
    }

    allRows = data.rows.map((r) => ({
      ...r,
      keyPatternStr: JSON.stringify(r.keyPattern),
      flagsStr: r.flags.join("; "),
    }));

    renderSubtitle(data);
    renderCards(data.summary);
    populateDbFilter(allRows);
    applyFiltersAndRender();
  } catch (err) {
    subtitle.textContent = `Failed to load report: ${err.message}`;
  }
}

function renderSubtitle(data) {
  const subtitle = document.getElementById("subtitle");
  const lastPolled = data.summary.lastPolledAt
    ? new Date(data.summary.lastPolledAt).toLocaleString()
    : "n/a";
  const trackingSince = data.summary.oldestTrackingStart
    ? new Date(data.summary.oldestTrackingStart).toLocaleString()
    : "n/a";
  subtitle.textContent = `${data.summary.totalTracked} index(es) tracked (excl. _id_) \u2022 tracking since ${trackingSince} \u2022 last poll ${lastPolled}`;
}

function renderCards(summary) {
  const cardsEl = document.getElementById("cards");
  const cardDefs = [
    { key: "totalTracked", label: "Total Tracked", category: null },
    { key: "candidate", label: "Candidates for Removal", category: "candidate" },
    { key: "review", label: "Review Manually", category: "review" },
    { key: "doNotDrop", label: "Do Not Drop (TTL)", category: "do_not_drop" },
    { key: "tooEarly", label: "Too Early", category: "too_early" },
    { key: "keep", label: "Keep (In Use)", category: "keep" },
  ];

  cardsEl.innerHTML = cardDefs
    .map(
      (c) => `
      <div class="card ${c.category ? `card-${c.category}` : ""}">
        <div class="value">${summary[c.key]}</div>
        <div class="label">${c.label}</div>
      </div>`
    )
    .join("");
}

function populateDbFilter(rows) {
  const select = document.getElementById("dbFilter");
  const current = select.value;
  const dbs = [...new Set(rows.map((r) => r.db))].sort();

  select.innerHTML =
    `<option value="all">All databases</option>` +
    dbs.map((db) => `<option value="${db}">${db}</option>`).join("");

  if (dbs.includes(current)) select.value = current;
}

function applyFiltersAndRender() {
  const search = document.getElementById("searchInput").value.trim().toLowerCase();
  const category = document.getElementById("categoryFilter").value;
  const db = document.getElementById("dbFilter").value;
  const hideKeep = document.getElementById("hideKeep").checked;

  let rows = allRows.filter((r) => {
    if (category !== "all" && r.category !== category) return false;
    if (db !== "all" && r.db !== db) return false;
    if (hideKeep && r.category === "keep") return false;
    if (search) {
      const haystack = `${r.db} ${r.collection} ${r.index}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  rows = sortRows(rows, sortKey, sortDir);
  renderTable(rows);
  updateSortIndicators();
}

function sortRows(rows, key, dir) {
  const sorted = [...rows].sort((a, b) => {
    let av = a[key];
    let bv = b[key];
    if (typeof av === "string") av = av.toLowerCase();
    if (typeof bv === "string") bv = bv.toLowerCase();
    if (av < bv) return dir === "asc" ? -1 : 1;
    if (av > bv) return dir === "asc" ? 1 : -1;
    return 0;
  });
  return sorted;
}

function renderTable(rows) {
  const tbody = document.getElementById("tableBody");
  const emptyState = document.getElementById("emptyState");

  if (rows.length === 0) {
    tbody.innerHTML = "";
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  tbody.innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td>${r.db}</td>
        <td>${r.collection}</td>
        <td><strong>${r.index}</strong></td>
        <td class="key-pattern">${r.keyPatternStr}</td>
        <td class="num">${r.totalOps}</td>
        <td class="num">${r.pollCount}</td>
        <td class="num">${r.resetsSeen}</td>
        <td class="num">${r.daysTracked}</td>
        <td class="flags">${r.flagsStr || "&mdash;"}</td>
        <td><span class="badge badge-${r.category}">${CATEGORY_LABELS[r.category] || r.recommendation}</span></td>
      </tr>`
    )
    .join("");
}

function updateSortIndicators() {
  document.querySelectorAll("th[data-key]").forEach((th) => {
    th.classList.remove("sorted");
    th.removeAttribute("data-arrow");
    if (th.dataset.key === sortKey) {
      th.classList.add("sorted");
      th.setAttribute("data-arrow", sortDir === "asc" ? "\u2191" : "\u2193");
    }
  });
}

function exportCsv() {
  const search = document.getElementById("searchInput").value.trim().toLowerCase();
  const category = document.getElementById("categoryFilter").value;
  const db = document.getElementById("dbFilter").value;
  const hideKeep = document.getElementById("hideKeep").checked;

  let rows = allRows.filter((r) => {
    if (category !== "all" && r.category !== category) return false;
    if (db !== "all" && r.db !== db) return false;
    if (hideKeep && r.category === "keep") return false;
    if (search) {
      const haystack = `${r.db} ${r.collection} ${r.index}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
  rows = sortRows(rows, sortKey, sortDir);

  const headers = [
    "db",
    "collection",
    "index",
    "keyPatternStr",
    "totalOps",
    "pollCount",
    "resetsSeen",
    "daysTracked",
    "flagsStr",
    "recommendation",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => `"${String(r[h]).replace(/"/g, '""')}"`).join(","));
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `index-usage-report-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById("refreshBtn").addEventListener("click", loadReport);
document.getElementById("exportBtn").addEventListener("click", exportCsv);
document.getElementById("searchInput").addEventListener("input", applyFiltersAndRender);
document.getElementById("categoryFilter").addEventListener("change", applyFiltersAndRender);
document.getElementById("dbFilter").addEventListener("change", applyFiltersAndRender);
document.getElementById("hideKeep").addEventListener("change", applyFiltersAndRender);

document.querySelectorAll("th[data-key]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = "asc";
    }
    applyFiltersAndRender();
  });
});

loadReport();
