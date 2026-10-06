const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const copyButton = document.querySelector("#copyButton");
const downloadButton = document.querySelector("#downloadButton");
const clearButton = document.querySelector("#clearButton");
const importFile = document.querySelector("#importFile");
const maxJobsInput = document.querySelector("#maxJobs");
const delayMsInput = document.querySelector("#delayMs");
const itemList = document.querySelector("#itemList");
const statusText = document.querySelector("#status");
const savedCount = document.querySelector("#savedCount");
const duplicateCount = document.querySelector("#duplicateCount");
const attemptCount = document.querySelector("#attemptCount");
const sourcePage = document.querySelector("#sourcePage");
const selectAllButton = document.querySelector("#selectAllButton");
const clearSelectionButton = document.querySelector("#clearSelectionButton");
const openSelectedButton = document.querySelector("#openSelectedButton");
const openAndMarkButton = document.querySelector("#openAndMarkButton");
const markAppliedButton = document.querySelector("#markAppliedButton");
const markNotAppliedButton = document.querySelector("#markNotAppliedButton");
const domainSelect = document.querySelector("#domainSelect");
const appliedFilter = document.querySelector("#appliedFilter");
const selectDomainButton = document.querySelector("#selectDomainButton");

let allItems = [];
let currentItems = [];
const selectedKeys = new Set();

startButton.addEventListener("click", startJobright);
stopButton.addEventListener("click", stopJobright);
copyButton.addEventListener("click", copyMarkdown);
downloadButton.addEventListener("click", downloadMarkdown);
clearButton.addEventListener("click", clearSaved);
importFile.addEventListener("change", importMarkdownFile);
selectAllButton.addEventListener("click", selectAllItems);
clearSelectionButton.addEventListener("click", clearSelection);
openSelectedButton.addEventListener("click", openSelectedTabs);
openAndMarkButton.addEventListener("click", openSelectedAndMarkApplied);
markAppliedButton.addEventListener("click", () => markSelectedApplied(true));
markNotAppliedButton.addEventListener("click", () => markSelectedApplied(false));
selectDomainButton.addEventListener("click", selectDomainItems);
appliedFilter.addEventListener("change", applyFilters);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "STATE_CHANGED") renderState(message.state);
});

refresh();

async function startJobright() {
  const tab = await getActiveTab();

  if (!tab?.url?.startsWith("https://jobright.ai/jobs/recommend")) {
    renderError("Open https://jobright.ai/jobs/recommend first.");
    return;
  }

  const options = {
    maxJobs: clampNumber(maxJobsInput.value, 1, 1000, 100),
    delayMs: clampNumber(delayMsInput.value, 500, 15000, 2500)
  };

  await chrome.runtime.sendMessage({ type: "START_JOBRIGHT", tabId: tab.id, sourceUrl: tab.url, options });
  await chrome.tabs.sendMessage(tab.id, { type: "JOBRIGHT_START", options });
  refresh();
}

async function stopJobright() {
  const tab = await getActiveTab();
  await chrome.runtime.sendMessage({ type: "STOP_JOBRIGHT" });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "JOBRIGHT_STOP" }).catch(() => {});
  refresh();
}

async function copyMarkdown() {
  const state = await getState();
  await navigator.clipboard.writeText(toMarkdown(state));
  statusText.textContent = "Copied";
}

async function downloadMarkdown() {
  const state = await getState();
  const url = URL.createObjectURL(new Blob([toMarkdown(state)], { type: "text/markdown" }));
  const filename = `job-urls-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
  chrome.downloads.download({ url, filename, saveAs: true }, () => URL.revokeObjectURL(url));
}

async function importMarkdownFile() {
  const file = importFile.files?.[0];
  if (!file) return;

  const text = await file.text();
  const items = parseMarkdownItems(text);
  const urls = extractUrls(text);
  const response = await chrome.runtime.sendMessage({ type: "IMPORT_MD_ITEMS", items, urls });
  statusText.textContent = `Imported ${response.added || 0} rows, ${response.skipUrls || 0} skip URLs`;
  importFile.value = "";
  refresh();
}

async function clearSaved() {
  selectedKeys.clear();
  await chrome.runtime.sendMessage({ type: "CLEAR_RESULTS" });
  refresh();
}

async function refresh() {
  renderState(await getState());
}

async function getState() {
  return chrome.runtime.sendMessage({ type: "GET_STATE" });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function renderState(state) {
  const fetchedItems = state?.items || [];
  const importedItems = state?.importedItems || [];
  const items = [...importedItems, ...fetchedItems];
  allItems = items;
  currentItems = getFilteredItems(allItems);
  statusText.textContent = state?.running ? "Running" : "Idle";
  startButton.disabled = Boolean(state?.running);
  stopButton.disabled = !state?.running;
  savedCount.textContent = String(items.length);
  duplicateCount.textContent = String(state?.duplicates || 0);
  attemptCount.textContent = String(state?.attempts || 0);
  sourcePage.textContent = state?.sourceUrl || "";

  for (const key of Array.from(selectedKeys)) {
    if (!currentItems.some((item) => getItemKey(item) === key)) selectedKeys.delete(key);
  }

  if (!items.length && !(state?.runs || []).length) {
    renderMessage(state?.lastError || "No saved jobs yet.");
    updateSelectionControls();
    return;
  }

  if (!currentItems.length) {
    renderMessage("No jobs match the current filter.");
    updateSelectionControls();
    return;
  }

  renderItemList(currentItems);
  updateSelectionControls();
}

function renderItemList(items) {
  itemList.textContent = "";

  if (!items.length) {
    renderMessage("No saved jobs yet.");
    return;
  }

  const fragment = document.createDocumentFragment();

  items.slice().reverse().forEach((item) => {
    const row = document.createElement("div");
    row.className = `job-row${item.applied ? " is-applied" : ""}`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedKeys.has(getItemKey(item));
    checkbox.setAttribute("aria-label", "Select job");
    checkbox.addEventListener("change", () => {
      const key = getItemKey(item);
      if (checkbox.checked) selectedKeys.add(key);
      else selectedKeys.delete(key);
      updateSelectionControls();
    });

    const body = document.createElement("span");
    body.className = "job-row-body";

    const title = document.createElement("strong");
    const importedLabel = item.imported ? " / Imported" : "";
    title.textContent = `${getSourceLabel(item.url)}${importedLabel} | ${item.company || "Unknown company"} - ${item.role || "Unknown role"}`;

    const url = document.createElement("span");
    url.className = "job-url";
    url.textContent = item.url || "";

    const appliedControl = document.createElement("label");
    appliedControl.className = "applied-toggle";

    const appliedCheckbox = document.createElement("input");
    appliedCheckbox.type = "checkbox";
    appliedCheckbox.checked = Boolean(item.applied);
    appliedCheckbox.addEventListener("change", async () => {
      const applied = appliedCheckbox.checked;
      appliedCheckbox.disabled = true;
      await chrome.runtime.sendMessage({ type: "UPDATE_APPLIED", item: toItemRef(item), applied });
      await refresh();
      statusText.textContent = applied ? "Marked applied" : "Marked not applied";
    });

    const appliedText = document.createElement("span");
    appliedText.textContent = "Applied";

    appliedControl.append(appliedCheckbox, appliedText);
    body.append(title, url);
    row.append(checkbox, body, appliedControl);
    fragment.append(row);
  });

  itemList.append(fragment);
}

function renderMessage(message) {
  itemList.textContent = message;
}

function renderError(message) {
  statusText.textContent = "Error";
  renderMessage(message);
}

function selectAllItems() {
  currentItems.forEach((item) => {
    if (item.url) selectedKeys.add(getItemKey(item));
  });
  renderItemList(currentItems);
  updateSelectionControls();
}

function selectDomainItems() {
  const sourceKey = domainSelect.value;
  currentItems.forEach((item) => {
    if (!item.url) return;
    if (sourceKey === "all" || getSourceKey(item.url) === sourceKey) selectedKeys.add(getItemKey(item));
  });
  renderItemList(currentItems);
  updateSelectionControls();
}

function clearSelection() {
  selectedKeys.clear();
  renderItemList(currentItems);
  updateSelectionControls();
}

async function openSelectedTabs() {
  const urls = getSelectedUrls();

  for (const url of urls) {
    await chrome.tabs.create({ url, active: false });
  }

  statusText.textContent = `Opened ${urls.length}`;
}

async function openSelectedAndMarkApplied() {
  const urls = getSelectedUrls();
  if (!urls.length) return;

  const items = getSelectedItemRefs();
  const response = await chrome.runtime.sendMessage({ type: "UPDATE_APPLIED_BULK", items, applied: true });
  await refresh();

  for (const url of urls) {
    await chrome.tabs.create({ url, active: false });
  }

  statusText.textContent = `Opened ${urls.length}, marked ${response.updated ?? 0} applied`;
}

async function markSelectedApplied(applied) {
  const urls = getSelectedUrls();
  if (!urls.length) return;

  const items = getSelectedItemRefs();
  const response = await chrome.runtime.sendMessage({ type: "UPDATE_APPLIED_BULK", items, applied });
  await refresh();
  statusText.textContent = applied ? `Marked ${response.updated ?? 0} applied` : `Marked ${response.updated ?? 0} not applied`;
}
function applyFilters() {
  currentItems = getFilteredItems(allItems);
  for (const key of Array.from(selectedKeys)) {
    if (!currentItems.some((item) => getItemKey(item) === key)) selectedKeys.delete(key);
  }

  if (!currentItems.length) renderMessage("No jobs match the current filter.");
  else renderItemList(currentItems);
  updateSelectionControls();
}

function getFilteredItems(items) {
  const filter = appliedFilter.value;
  if (filter === "applied") return items.filter((item) => Boolean(item.applied));
  if (filter === "not-applied") return items.filter((item) => !item.applied);
  return items;
}

function getSelectedItems() {
  return currentItems.filter((item) => selectedKeys.has(getItemKey(item)));
}

function getSelectedItemRefs() {
  return getSelectedItems().map(toItemRef);
}

function getSelectedUrls() {
  return Array.from(new Set(getSelectedItems().map((item) => item.url).filter(Boolean)));
}

function toItemRef(item) {
  return {
    company: item.company || "",
    role: item.role || "",
    url: item.url || ""
  };
}

function getItemKey(item) {
  return dedupeKey(item);
}

function updateSelectionControls() {
  const hasSelection = selectedKeys.size > 0;
  openSelectedButton.disabled = !hasSelection;
  openAndMarkButton.disabled = !hasSelection;
  markAppliedButton.disabled = !hasSelection;
  markNotAppliedButton.disabled = !hasSelection;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function toMarkdown(state) {
  const items = state?.items || [];
  const importedItems = state?.importedItems || [];
  const runs = state?.runs?.length ? state.runs : [{ id: "legacy", label: "V1", date: "", itemIds: items.map(dedupeKey) }];
  const sections = [];

  if (importedItems.length) {
    sections.push("## Imported");
    for (const group of groupItemsBySource(importedItems)) {
      sections.push("");
      sections.push(`### ${group.label}`);
      sections.push(toTable(group.items));
    }
  }

  for (const run of runs) {
    const runItems = items.filter((item) => item.runId === run.id || (run.itemIds || []).includes(dedupeKey(item)));
    const groups = groupItemsBySource(runItems);

    sections.push(`## ${run.label || "V1"}${run.date ? ` - ${run.date}` : ""}`);

    for (const group of groups) {
      sections.push("");
      sections.push(`### ${group.label}`);
      sections.push(toTable(group.items));
    }
  }

  return sections.join("\n").trim();
}
function toTable(items) {
  const rows = (items || []).map((item) => {
    const company = markdownCell(item.company || "");
    const role = markdownCell(item.role || "");
    const url = markdownCell(item.url || "");
    const applied = item.applied ? "Yes" : "No";
    return `| ${company} | ${role} | ${url} | ${applied} |`;
  });

  return ["| Company | Role | URL | Applied |", "| --- | --- | --- | --- |", ...rows].join("\n");
}
function parseMarkdownItems(text) {
  const rows = [];

  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;

    const cells = splitMarkdownRow(trimmed);
    if (cells.length < 3) continue;

    const headerCells = cells.map((cell) => cleanMarkdownCell(cell).toLowerCase());
    if (headerCells[0] === "company" && headerCells[1] === "role" && headerCells[2] === "url") continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) continue;

    const url = normalizeUrl(extractFirstUrl(cells[2]));
    if (!url) continue;

    rows.push({
      company: cleanMarkdownCell(cells[0]) || "Imported",
      role: cleanMarkdownCell(cells[1]),
      url,
      applied: parseAppliedCell(cells[3]),
      imported: true,
      source: "imported-md"
    });
  }

  if (rows.length) return dedupeImportedRows(rows);

  return extractUrls(text).map((url) => ({
    company: "Imported",
    role: "",
    url,
    applied: false,
    imported: true,
    source: "imported-md"
  }));
}

function parseAppliedCell(value) {
  const normalized = cleanMarkdownCell(value).toLowerCase();
  return ["yes", "y", "true", "1", "applied", "done"].includes(normalized);
}

function splitMarkdownRow(line) {
  const content = line.replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cell = "";
  let escaping = false;

  for (const character of content) {
    if (escaping) {
      cell += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (character === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }

    cell += character;
  }

  cells.push(cell.trim());
  return cells;
}

function cleanMarkdownCell(value) {
  return String(value || "")
    .replace(/\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\\\|/g, "|")
    .replace(/<br\s*\/?\>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirstUrl(value) {
  const match = String(value || "").match(/https?:\/\/[^\s|)<>]+/);
  return match ? match[0] : value;
}

function dedupeImportedRows(rows) {
  const seen = new Set();
  const unique = [];

  for (const row of rows) {
    const key = normalizeUrl(row.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }

  return unique;
}

function extractUrls(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s|)<>]+/g) || [];
  return Array.from(new Set(matches.map((url) => normalizeUrl(url)).filter(Boolean)));
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(String(url).trim().replace(/\\+$/, ""));
    parsed.hash = "";
    parsed.searchParams.delete("jr_id");
    return parsed.href;
  } catch {
    return "";
  }
}

function dedupeKey(item) {
  return [item.company, item.role, item.url].map((value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase()).join("|");
}

function groupItemsBySource(items) {
  const definitions = [
    { key: "normal", label: "No-linkedin url", match: (url) => getSourceKey(url) === "normal" },
    { key: "lever", label: "Lever", match: (url) => getSourceKey(url) === "lever" },
    { key: "adp", label: "ADP", match: (url) => getSourceKey(url) === "adp" },
    { key: "workable", label: "Workable", match: (url) => getSourceKey(url) === "workable" },
    { key: "paylocity", label: "Paylocity", match: (url) => getSourceKey(url) === "paylocity" },
    { key: "ziprecruiter", label: "ZipRecruiter", match: (url) => getSourceKey(url) === "ziprecruiter" },
    { key: "dice", label: "Dice", match: (url) => getSourceKey(url) === "dice" },
    { key: "rippling", label: "Rippling", match: (url) => getSourceKey(url) === "rippling" },
    { key: "bamboohr", label: "BambooHR", match: (url) => getSourceKey(url) === "bamboohr" },
    { key: "workday", label: "Workday", match: (url) => getSourceKey(url) === "workday" },
    { key: "greenhouse", label: "Greenhouse", match: (url) => getSourceKey(url) === "greenhouse" },
    { key: "linkedin", label: "Linkedin", match: (url) => getSourceKey(url) === "linkedin" }
  ];

  return definitions.map((definition) => ({
    label: definition.label,
    items: items.filter((item) => definition.match(item.url))
  }));
}

function getSourceLabel(url) {
  const key = getSourceKey(url);
  const labels = {
    normal: "No-linkedin",
    lever: "Lever",
    adp: "ADP",
    workable: "Workable",
    paylocity: "Paylocity",
    ziprecruiter: "ZipRecruiter",
    dice: "Dice",
    rippling: "Rippling",
    bamboohr: "BambooHR",
    workday: "Workday",
    greenhouse: "Greenhouse",
    linkedin: "Linkedin"
  };
  return labels[key] || "Other";
}

function getSourceKey(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return "normal";
  }

  if (hostname.endsWith("linkedin.com")) return "linkedin";
  if (hostname.includes("greenhouse.io")) return "greenhouse";
  if (hostname === "jobs.lever.co" || hostname.endsWith(".lever.co")) return "lever";
  if (hostname.endsWith("adp.com")) return "adp";
  if (hostname.endsWith("workable.com")) return "workable";
  if (hostname.endsWith("paylocity.com")) return "paylocity";
  if (hostname.endsWith("ziprecruiter.com")) return "ziprecruiter";
  if (hostname.endsWith("dice.com")) return "dice";
  if (hostname.endsWith("rippling.com")) return "rippling";
  if (hostname.endsWith("bamboohr.com")) return "bamboohr";
  if (hostname.endsWith("myworkdayjobs.com") || hostname.includes(".wd1.myworkdayjobs.com") || hostname.includes(".wd5.myworkdayjobs.com")) return "workday";

  return "normal";
}

function isLinkedInUrl(url) {
  return getSourceKey(url) === "linkedin";
}

function isGreenhouseUrl(url) {
  return getSourceKey(url) === "greenhouse";
}

function markdownCell(value) {
  return String(value)
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}













