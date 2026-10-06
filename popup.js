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
const domainSelect = document.querySelector("#domainSelect");
const selectDomainButton = document.querySelector("#selectDomainButton");

let currentItems = [];
const selectedUrls = new Set();

startButton.addEventListener("click", startJobright);
stopButton.addEventListener("click", stopJobright);
copyButton.addEventListener("click", copyMarkdown);
downloadButton.addEventListener("click", downloadMarkdown);
clearButton.addEventListener("click", clearSaved);
importFile.addEventListener("change", importMarkdownFile);
selectAllButton.addEventListener("click", selectAllItems);
clearSelectionButton.addEventListener("click", clearSelection);
openSelectedButton.addEventListener("click", openSelectedTabs);
selectDomainButton.addEventListener("click", selectDomainItems);

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
  const urls = extractUrls(text);
  const response = await chrome.runtime.sendMessage({ type: "IMPORT_SKIP_URLS", urls });
  statusText.textContent = `Imported ${response.imported || 0}`;
  importFile.value = "";
  refresh();
}

async function clearSaved() {
  selectedUrls.clear();
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
  const items = state?.items || [];
  currentItems = items;
  statusText.textContent = state?.running ? "Running" : "Idle";
  startButton.disabled = Boolean(state?.running);
  stopButton.disabled = !state?.running;
  savedCount.textContent = String(items.length);
  duplicateCount.textContent = String(state?.duplicates || 0);
  attemptCount.textContent = String(state?.attempts || 0);
  sourcePage.textContent = state?.sourceUrl || "";

  for (const url of Array.from(selectedUrls)) {
    if (!items.some((item) => item.url === url)) selectedUrls.delete(url);
  }

  if (!items.length && !(state?.runs || []).length) {
    renderMessage(state?.lastError || "No saved jobs yet.");
    updateSelectionControls();
    return;
  }

  renderItemList(items);
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
    const label = document.createElement("label");
    label.className = "job-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedUrls.has(item.url);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedUrls.add(item.url);
      else selectedUrls.delete(item.url);
      updateSelectionControls();
    });

    const body = document.createElement("span");
    body.className = "job-row-body";

    const title = document.createElement("strong");
    title.textContent = `${getSourceLabel(item.url)} | ${item.company || "Unknown company"} - ${item.role || "Unknown role"}`;

    const url = document.createElement("span");
    url.className = "job-url";
    url.textContent = item.url || "";

    body.append(title, url);
    label.append(checkbox, body);
    fragment.append(label);
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
    if (item.url) selectedUrls.add(item.url);
  });
  renderItemList(currentItems);
  updateSelectionControls();
}

function selectDomainItems() {
  const sourceKey = domainSelect.value;
  currentItems.forEach((item) => {
    if (!item.url) return;
    if (sourceKey === "all" || getSourceKey(item.url) === sourceKey) selectedUrls.add(item.url);
  });
  renderItemList(currentItems);
  updateSelectionControls();
}

function clearSelection() {
  selectedUrls.clear();
  renderItemList(currentItems);
  updateSelectionControls();
}

async function openSelectedTabs() {
  const urls = currentItems
    .map((item) => item.url)
    .filter((url) => selectedUrls.has(url));

  for (const url of urls) {
    await chrome.tabs.create({ url, active: false });
  }

  statusText.textContent = `Opened ${urls.length}`;
}

function updateSelectionControls() {
  openSelectedButton.disabled = selectedUrls.size === 0;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function toMarkdown(state) {
  const items = state?.items || [];
  const runs = state?.runs?.length ? state.runs : [{ id: "legacy", label: "V1", date: "", itemIds: items.map(dedupeKey) }];
  const sections = [];

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
    return `| ${company} | ${role} | ${url} |`;
  });

  return ["| Company | Role | URL |", "| --- | --- | --- |", ...rows].join("\n");
}

function extractUrls(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s|)<>]+/g) || [];
  return Array.from(new Set(matches.map((url) => normalizeUrl(url)).filter(Boolean)));
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(String(url).trim());
    parsed.hash = "";
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


