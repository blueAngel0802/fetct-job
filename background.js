const DEFAULT_STATE = {
  running: false,
  sourceUrl: "",
  items: [],
  runs: [],
  currentRunId: "",
  attempts: 0,
  duplicates: 0,
  lastError: "",
  skipUrls: []
};

const pendingCaptures = [];
const captureByTab = new Map();
const CAPTURE_TIMEOUT_MS = 6000;
const PENDING_TIMEOUT_MS = 10000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(async (error) => {
      const state = await getState();
      state.lastError = error.message || String(error);
      await setState(state);
      sendResponse({ ok: false, error: state.lastError });
    });
  return true;
});

chrome.tabs.onCreated.addListener((tab) => {
  const capture = claimPendingCapture(tab);
  if (!capture) return;

  captureByTab.set(tab.id, { ...capture, createdAt: Date.now() });
  scheduleCaptureCleanup(tab.id);

  if (tab.url && !isInternalUrl(tab.url)) {
    finishCapture(tab.id, tab, tab.url, captureByTab.get(tab.id));
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const capture = captureByTab.get(tabId);
  if (!capture) return;

  const url = changeInfo.url || (changeInfo.status === "complete" ? tab.url : "");
  if (!url || isInternalUrl(url)) return;

  finishCapture(tabId, tab, url, capture);
});

chrome.tabs.onRemoved.addListener((tabId) => captureByTab.delete(tabId));

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_STATE":
      return getState();

    case "START_JOBRIGHT": {
      const state = await getState();
      const run = createRun(state, message.sourceUrl || "");
      state.running = true;
      state.sourceUrl = message.sourceUrl || "";
      state.currentRunId = run.id;
      state.lastError = "";
      state.runs.push(run);
      await setState(state);
      return { ok: true, runId: run.id };
    }

    case "STOP_JOBRIGHT": {
      const state = await getState();
      state.running = false;
      closeCurrentRun(state, "Stopped by user.");
      await setState(state);
      return { ok: true };
    }

    case "CLEAR_RESULTS":
      await setState({ ...DEFAULT_STATE, items: [], runs: [], skipUrls: [] });
      return { ok: true };

    case "IMPORT_SKIP_URLS": {
      const state = await getState();
      const known = new Set((state.skipUrls || []).map(normalizeUrlForCompare));
      for (const url of message.urls || []) {
        const normalized = normalizeUrlForCompare(url);
        if (normalized) known.add(normalized);
      }
      state.skipUrls = Array.from(known);
      await setState(state);
      return { ok: true, imported: state.skipUrls.length };
    }

    case "QUEUE_APPLY_CAPTURE": {
      const state = await getState();
      prunePendingCaptures();
      pendingCaptures.push({
        job: message.job,
        runId: state.currentRunId,
        source: message.source || "jobright",
        openerTabId: sender.tab?.id,
        windowId: sender.tab?.windowId,
        createdAt: Date.now()
      });
      return { ok: true };
    }

    case "CAPTURE_TIMEOUT":
      prunePendingCaptures();
      return { ok: true };

    case "JOB_ATTEMPTED": {
      const state = await getState();
      state.attempts += 1;
      updateCurrentRun(state, (run) => {
        run.attempts = (run.attempts || 0) + 1;
      });
      await setState(state);
      return { ok: true };
    }

    case "JOBRIGHT_DONE": {
      const state = await getState();
      state.running = false;
      state.lastError = message.reason || "";
      closeCurrentRun(state, message.reason || "Finished.");
      await setState(state);
      return { ok: true };
    }

    default:
      return { ok: false, error: "Unknown message type." };
  }
}

function claimPendingCapture(tab) {
  prunePendingCaptures();

  let index = pendingCaptures.findIndex((capture) => capture.openerTabId && capture.openerTabId === tab.openerTabId);
  if (index < 0) {
    index = pendingCaptures.findIndex((capture) => capture.windowId === tab.windowId);
  }
  if (index < 0 && pendingCaptures.length) {
    index = 0;
  }
  if (index < 0) return null;

  return pendingCaptures.splice(index, 1)[0];
}

function prunePendingCaptures() {
  const cutoff = Date.now() - PENDING_TIMEOUT_MS;
  for (let index = pendingCaptures.length - 1; index >= 0; index -= 1) {
    if (pendingCaptures[index].createdAt < cutoff) pendingCaptures.splice(index, 1);
  }
}

function scheduleCaptureCleanup(tabId) {
  setTimeout(async () => {
    const capture = captureByTab.get(tabId);
    if (!capture) return;

    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      captureByTab.delete(tabId);
      return;
    }

    if (tab.url && !isInternalUrl(tab.url)) {
      await finishCapture(tabId, tab, tab.url, capture);
      return;
    }

    captureByTab.delete(tabId);
    chrome.tabs.remove(tabId).catch(() => {});
  }, CAPTURE_TIMEOUT_MS);
}

async function finishCapture(tabId, tab, url, capture) {
  if (!capture) return;
  captureByTab.delete(tabId);

  const state = await getState();
  const finalUrl = normalizeUrl(url);

  if (isBlockedJobUrl(finalUrl) || shouldSkipUrl(state, finalUrl)) {
    await setState(state);
    if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
    return;
  }

  const item = {
    company: capture.job?.company || "",
    role: capture.job?.role || "",
    url: finalUrl,
    source: capture.source,
    runId: capture.runId || state.currentRunId,
    capturedAt: new Date().toISOString(),
    isLinkedIn: isLinkedInUrl(finalUrl),
    isGreenhouse: isGreenhouseUrl(finalUrl)
  };

  const known = new Set(state.items.map(dedupeKey));

  if (known.has(dedupeKey(item))) {
    state.duplicates += 1;
    updateRunById(state, item.runId, (run) => {
      run.duplicates = (run.duplicates || 0) + 1;
    });
  } else {
    state.items.push(item);
    updateRunById(state, item.runId, (run) => {
      run.itemIds = run.itemIds || [];
      run.itemIds.push(dedupeKey(item));
    });
  }

  await setState(state);
  if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
}

async function getState() {
  const stored = await chrome.storage.local.get("state");
  const state = { ...DEFAULT_STATE, ...(stored.state || {}) };
  state.items = state.items || [];
  state.runs = state.runs || [];
  state.skipUrls = state.skipUrls || [];

  if (!state.runs.length && state.items.length) {
    const run = createRun(state, state.sourceUrl || "");
    run.version = 1;
    run.label = "V1";
    run.status = "Migrated";
    run.itemIds = state.items.map(dedupeKey);
    state.runs = [run];
    state.items = state.items.map((item) => ({ ...item, runId: run.id }));
  }

  return state;
}

async function setState(state) {
  await chrome.storage.local.set({ state });
  chrome.runtime.sendMessage({ type: "STATE_CHANGED", state }).catch(() => {});
}

function createRun(state, sourceUrl) {
  const date = localDateKey();
  const version = state.runs.filter((run) => run.date === date).length + 1;
  return {
    id: `${date}-v${version}-${Date.now()}`,
    date,
    version,
    label: `V${version}`,
    sourceUrl,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    status: "Running",
    attempts: 0,
    duplicates: 0,
    itemIds: []
  };
}

function closeCurrentRun(state, status) {
  updateCurrentRun(state, (run) => {
    run.status = status;
    run.finishedAt = new Date().toISOString();
  });
}

function updateCurrentRun(state, updater) {
  updateRunById(state, state.currentRunId, updater);
}

function updateRunById(state, runId, updater) {
  const run = state.runs.find((candidate) => candidate.id === runId);
  if (run) updater(run);
}

function localDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shouldSkipUrl(state, url) {
  const normalized = normalizeUrlForCompare(url);
  if (!normalized) return false;
  return new Set(state.skipUrls || []).has(normalized);
}

function normalizeUrlForCompare(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    parsed.hash = "";
    return parsed.href.toLowerCase();
  } catch {
    return "";
  }
}

function dedupeKey(item) {
  return [item.company, item.role, item.url].map((value) => normalizeText(value || "")).join("|");
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

function isInternalUrl(url) {
  return !url || url.startsWith("chrome://") || url.startsWith("about:") || url.includes("jobright.ai");
}

function isLinkedInUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase().endsWith("linkedin.com");
  } catch {
    return false;
  }
}


