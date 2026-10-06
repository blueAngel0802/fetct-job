let running = false;
let seenCards = new Set();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "JOBRIGHT_START") {
    if (!running) {
      running = true;
      seenCards = new Set();
      runJobright(message.options || {}).catch((error) => {
        running = false;
        chrome.runtime.sendMessage({ type: "JOBRIGHT_DONE", reason: error.message || String(error) });
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "JOBRIGHT_STOP") {
    running = false;
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

async function runJobright(options) {
  const maxJobs = Number(options.maxJobs || 100);
  const delayMs = Number(options.delayMs || 2500);
  let processed = 0;
  let emptyRounds = 0;

  while (running && processed < maxJobs) {
    const card = getNextJobCard();

    if (!card) {
      emptyRounds += 1;
      scrollJobList(emptyRounds);
      await sleep(Math.min(5000, 900 + emptyRounds * 350));
      continue;
    }

    emptyRounds = 0;
    seenCards.add(getCardKey(card));

    const job = extractJob(card);
    processed += 1;

    await safeSend({ type: "JOB_ATTEMPTED", job: publicJob(job) });
    await openApplyUrl(job, delayMs);
    await sleep(delayMs);
  }

  running = false;
  await safeSend({
    type: "JOBRIGHT_DONE",
    reason: processed >= maxJobs ? "Reached max jobs for this run." : "Stopped by user."
  });
}

async function openApplyUrl(job, delayMs) {
  job.card.scrollIntoView({ block: "center", behavior: "instant" });
  await sleep(500);

  let applyButton = findApplyButton(job.card);

  if (!applyButton) {
    clickCard(job.card);
    await sleep(1600);
    applyButton = await waitForApplyButton(6500, document);
  }

  if (!applyButton) {
    await safeSend({ type: "CAPTURE_TIMEOUT", job: publicJob(job) });
    return false;
  }

  await queueCapture(job);
  dispatchCtrlClick(applyButton);
  await sleep(Math.max(2200, delayMs));
  return true;
}

async function queueCapture(job) {
  await safeSend({
    type: "QUEUE_APPLY_CAPTURE",
    source: "jobright",
    job: publicJob(job)
  });
}

function getNextJobCard() {
  return getVisibleJobCards().find((card) => !seenCards.has(getCardKey(card)));
}

function getVisibleJobCards() {
  return Array.from(document.querySelectorAll(".job-card-flag-classname"))
    .filter((card) => card instanceof HTMLElement && card.offsetParent !== null);
}

function extractJob(card) {
  const rawText = card.innerText || card.textContent || "";
  const lines = rawText.split(/\r?\n/).map(cleanText).filter(Boolean);
  const role = pickRole(card, lines);
  const company = pickCompany(card, lines, role);

  return {
    card,
    company,
    role,
    text: cleanText(rawText)
  };
}

function publicJob(job) {
  return {
    company: job.company,
    role: job.role
  };
}

function pickRole(card, lines) {
  const titleElement = card.querySelector("[class*='job-title'], [class*='jobTitle'], [class*='title'], a[href*='/jobs/']");
  const title = cleanText(titleElement?.innerText || titleElement?.textContent || "");
  if (isGoodTitle(title)) return title;

  return lines.find(isGoodTitle) || lines[0] || "";
}

function pickCompany(card, lines, role) {
  const companyElement = card.querySelector("[class*='company'], [class*='Company']");
  const company = cleanText(companyElement?.innerText || companyElement?.textContent || "");
  if (company && company !== role && company.length <= 90) return company.split("\n")[0];

  const roleIndex = lines.findIndex((line) => normalizeText(line) === normalizeText(role));
  const candidates = roleIndex >= 0 ? lines.slice(roleIndex + 1) : lines;
  const companyLine = candidates.find((line) => {
    if (normalizeText(line) === normalizeText(role)) return false;
    if (/match|remote|hybrid|onsite|full-time|part-time|posted|ago|salary|apply|save|applicant|experience|skills|industry/i.test(line)) return false;
    return line.length > 1 && line.length <= 90;
  });

  return companyLine || "";
}

function isGoodTitle(line) {
  return line.length > 3 && line.length <= 120 && /engineer|developer|manager|analyst|architect|designer|scientist|administrator|consultant|specialist|lead|director|frontend|backend|full stack|software|data|devops|product|security|qa/i.test(line);
}

function clickCard(card) {
  card.scrollIntoView({ block: "center", behavior: "instant" });
  card.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
  card.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  card.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
}

async function waitForApplyButton(timeoutMs, root = document) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const button = findApplyButton(root);
    if (button) return button;
    await sleep(250);
  }
  return null;
}

function findApplyButton(root = document, options = {}) {
  const candidates = Array.from(root.querySelectorAll("button, a, [role='button']"))
    .filter((element) => isVisibleElement(element) && !element.disabled)
    .map((element) => ({ element, text: cleanText(element.innerText || element.textContent || element.getAttribute("aria-label") || "") }))
    .filter(({ text }) => isApplyText(text));

  if (!candidates.length) return null;

  const priorities = options.preferSecondStep
    ? [/^easy apply$/i, /^apply with autofill$/i, /^apply without autofill$/i, /^apply$/i, /^apply now$/i]
    : [/^easy apply$/i, /^apply with autofill$/i, /^apply without autofill$/i, /^apply now$/i, /^apply$/i];

  for (const pattern of priorities) {
    const match = candidates.find(({ text }) => pattern.test(text));
    if (match) return match.element;
  }

  return candidates[0].element;
}

function isApplyText(text) {
  return /^(easy apply|apply with autofill|apply without autofill|apply now|apply)$/i.test(cleanText(text));
}

function isVisibleElement(element) {
  return element instanceof HTMLElement && element.offsetParent !== null;
}

function dispatchCtrlClick(element) {
  element.scrollIntoView({ block: "center", behavior: "instant" });
  for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
    element.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      ctrlKey: true,
      metaKey: false,
      button: 0,
      buttons: type === "mouseup" || type === "click" ? 0 : 1
    }));
  }
}

function scrollJobList(emptyRounds = 0) {
  const scrollable = getJobScroller();
  const distance = Math.max(700, scrollable.clientHeight * 0.9) + emptyRounds * 120;
  scrollable.scrollBy({ top: distance, behavior: "smooth" });
}

function getJobScroller() {
  const byClass = Array.from(document.querySelectorAll("div[class*='jobs-list-scrollable']"))
    .find((element) => element.scrollHeight > element.clientHeight);
  if (byClass) return byClass;

  const card = getVisibleJobCards()[0];
  return findScrollableParent(card) || document.scrollingElement || document.documentElement;
}

function findScrollableParent(element) {
  let current = element?.parentElement;
  while (current) {
    const style = getComputedStyle(current);
    if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight) return current;
    current = current.parentElement;
  }
  return null;
}

function getCardKey(card) {
  const id = card.id || card.getAttribute("data-job-id") || card.querySelector("[id]")?.id;
  if (id) return `id:${id}`;

  const rawText = card.innerText || card.textContent || "";
  const lines = rawText.split(/\r?\n/).map(cleanText).filter(Boolean);
  return `text:${lines.slice(0, 4).join("|").toLowerCase()}`;
}

async function safeSend(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return cleanText(value).toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

