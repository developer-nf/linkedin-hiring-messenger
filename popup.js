const DEFAULT_TEMPLATE =
  "Hi {first_name}, thanks for applying for the {job_title} role. I would love to connect and share next steps.";

const DEFAULT_AWARENESS_TEMPLATE =
  "Hi {first_name}, thanks for applying for the {job_title} role. I wanted to share a quick awareness note and next steps.";

const STORAGE_KEYS = {
  state: "lhm_state"
};

const els = {
  template: document.getElementById("template"),
  awarenessTemplate: document.getElementById("awarenessTemplate"),
  sourceApplicants: document.getElementById("sourceApplicants"),
  sourceCandidates: document.getElementById("sourceCandidates"),
  messageCampaignMode: document.getElementById("messageCampaignMode"),
  awarenessCampaignMode: document.getElementById("awarenessCampaignMode"),
  sendToNotAFit: document.getElementById("sendToNotAFit"),
  notAFitSection: document.getElementById("notAFitSection"),
  manualMode: document.getElementById("manualMode"),
  autoMode: document.getElementById("autoMode"),
  sentCount: document.getElementById("sentCount"),
  candidateName: document.getElementById("candidateName"),
  runState: document.getElementById("runState"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  resetBtn: document.getElementById("resetBtn"),
  closeModalBtn: document.getElementById("closeModalBtn")
};

async function getState() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.state]);
  return (
    data[STORAGE_KEYS.state] || {
      running: false,
      status: "Stopped",
      sentCount: 0,
      currentCandidate: "-",
      mode: "manual",
      campaignMode: "message",
      pageSource: "applicants",
      template: DEFAULT_TEMPLATE,
      awarenessTemplate: DEFAULT_AWARENESS_TEMPLATE,
      maxPerSession: 25,
      sendToNotAFit: false
    }
  );
}

function getPageSource() {
  return els.sourceCandidates.checked ? "candidates" : "applicants";
}

function lockPageSources(changed) {
  if (changed === "applicants" && els.sourceApplicants.checked) {
    els.sourceCandidates.checked = false;
  }
  if (changed === "candidates" && els.sourceCandidates.checked) {
    els.sourceApplicants.checked = false;
  }
  if (!els.sourceApplicants.checked && !els.sourceCandidates.checked) {
    els.sourceApplicants.checked = true;
  }
  updateNotAFitVisibility();
}

function updateNotAFitVisibility() {
  if (!els.notAFitSection) return;
  els.notAFitSection.style.display = getPageSource() === "candidates" ? "none" : "";
}

function renderState(state) {
  els.template.value = state.template || DEFAULT_TEMPLATE;
  els.awarenessTemplate.value = state.awarenessTemplate || DEFAULT_AWARENESS_TEMPLATE;
  const pageSource = state.pageSource === "candidates" ? "candidates" : "applicants";
  els.sourceApplicants.checked = pageSource !== "candidates";
  els.sourceCandidates.checked = pageSource === "candidates";
  els.messageCampaignMode.checked = state.campaignMode !== "awareness";
  els.awarenessCampaignMode.checked = state.campaignMode === "awareness";
  els.sendToNotAFit.checked = Boolean(state.sendToNotAFit);
  els.manualMode.checked = state.mode !== "auto";
  els.autoMode.checked = state.mode === "auto";
  els.sentCount.textContent = String(state.sentCount || 0);
  els.candidateName.textContent = state.currentCandidate || "-";
  els.runState.textContent = state.status || (state.running ? "Running" : "Stopped");
  updateNotAFitVisibility();
}

async function updateStatePatch(patch) {
  const prev = await getState();
  const next = { ...prev, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.state]: next });
  return next;
}

async function sendToContent(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

function lockSendModes(changed) {
  if (changed === "manual" && els.manualMode.checked) {
    els.autoMode.checked = false;
  }
  if (changed === "auto" && els.autoMode.checked) {
    els.manualMode.checked = false;
  }
  if (!els.manualMode.checked && !els.autoMode.checked) {
    els.manualMode.checked = true;
  }
}

function lockCampaignModes(changed) {
  if (changed === "message" && els.messageCampaignMode.checked) {
    els.awarenessCampaignMode.checked = false;
  }
  if (changed === "awareness" && els.awarenessCampaignMode.checked) {
    els.messageCampaignMode.checked = false;
  }
  if (!els.messageCampaignMode.checked && !els.awarenessCampaignMode.checked) {
    els.messageCampaignMode.checked = true;
  }
}

function getCampaignMode() {
  return els.awarenessCampaignMode.checked ? "awareness" : "message";
}

async function getActiveHiringTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: [
      "https://www.linkedin.com/hiring/candidates/*",
      "https://www.linkedin.com/hiring/applicants/*",
      "https://www.linkedin.com/hiring/jobs/*/applicants/*"
    ]
  });
  return tabs[0] || null;
}

function detectPageSourceFromUrl(url) {
  const value = String(url || "");
  if (value.includes("/hiring/candidates/")) return "candidates";
  if (value.includes("/hiring/applicants/") || value.includes("/hiring/jobs/")) return "applicants";
  return null;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return true;
  } catch (_error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["utils.js", "content.js"]
      });
      // Give the script a moment to register listeners.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await chrome.tabs.sendMessage(tabId, { type: "PING" });
      return true;
    } catch (injectError) {
      console.error("[LHM][popup] Failed to inject content script:", injectError);
      return false;
    }
  }
}

async function startMessaging() {
  // Prefer the active hiring tab URL so Candidate Search works when that page is open.
  const tab = await getActiveHiringTab();
  if (!tab?.id) {
    els.runState.textContent = "Open Classical Mode or Normal tab first";
    return;
  }

  const detected = detectPageSourceFromUrl(tab.url);
  if (!detected) {
    els.runState.textContent = "Open a LinkedIn hiring Classical Mode or Normal page";
    return;
  }

  // Sync popup source to the open page (Candidates is primary when that tab is active).
  if (detected === "candidates") {
    els.sourceCandidates.checked = true;
    els.sourceApplicants.checked = false;
  } else {
    els.sourceApplicants.checked = true;
    els.sourceCandidates.checked = false;
  }
  updateNotAFitVisibility();

  const pageSource = detected;
  const injected = await ensureContentScript(tab.id);
  if (!injected) {
    els.runState.textContent = "Reload the LinkedIn tab, then Start again";
    return;
  }

  const mode = els.autoMode.checked ? "auto" : "manual";
  const campaignMode = getCampaignMode();
  const template = (els.template.value || "").trim() || DEFAULT_TEMPLATE;
  const awarenessTemplate =
    (els.awarenessTemplate.value || "").trim() || DEFAULT_AWARENESS_TEMPLATE;

  const startResponse = await chrome.runtime.sendMessage({
    type: "START_AUTOMATION",
    payload: {
      mode,
      campaignMode,
      pageSource,
      template,
      awarenessTemplate,
      sendToNotAFit: pageSource === "applicants" ? els.sendToNotAFit.checked : false
    }
  });
  if (!startResponse?.ok) {
    els.runState.textContent = "Failed to start";
    return;
  }

  try {
    await sendToContent(tab.id, { type: "RUN_AUTOMATION" });
  } catch (_error) {
    els.runState.textContent = "Reload the LinkedIn tab and try again";
    return;
  }
  await refresh();
}

async function stopMessaging() {
  await chrome.runtime.sendMessage({ type: "STOP_AUTOMATION" });
  const tab = await getActiveHiringTab();
  if (tab?.id) {
    await sendToContent(tab.id, { type: "STOP_AUTOMATION_NOW" }).catch(() => undefined);
  }
  await refresh();
}

async function resetSentList() {
  await chrome.runtime.sendMessage({ type: "RESET_SENT_LIST" });
  await refresh();
}

async function closeMessageModal() {
  const tab = await getActiveHiringTab();
  if (!tab?.id) {
    els.runState.textContent = "Open Classical Mode or Normal tab first";
    return;
  }
  try {
    await ensureContentScript(tab.id);
    const response = await sendToContent(tab.id, { type: "CLOSE_MESSAGE_MODAL" });
    els.runState.textContent = response?.ok ? "Modal close requested" : response?.error || "Close failed";
  } catch (err) {
    els.runState.textContent = "Reload the LinkedIn tab and try again";
  }
  await refresh();
}

async function saveDraftSettings() {
  const mode = els.autoMode.checked ? "auto" : "manual";
  const campaignMode = getCampaignMode();
  const pageSource = getPageSource();
  const template = (els.template.value || "").trim() || DEFAULT_TEMPLATE;
  const awarenessTemplate =
    (els.awarenessTemplate.value || "").trim() || DEFAULT_AWARENESS_TEMPLATE;
  await updateStatePatch({
    mode,
    campaignMode,
    pageSource,
    template,
    awarenessTemplate,
    sendToNotAFit: pageSource === "applicants" ? els.sendToNotAFit.checked : false
  });
}

async function refresh() {
  const state = await getState();
  renderState(state);
}

function bindEvents() {
  els.sourceApplicants.addEventListener("change", async () => {
    lockPageSources("applicants");
    await saveDraftSettings();
    await refresh();
  });

  els.sourceCandidates.addEventListener("change", async () => {
    lockPageSources("candidates");
    await saveDraftSettings();
    await refresh();
  });

  els.messageCampaignMode.addEventListener("change", async () => {
    lockCampaignModes("message");
    await saveDraftSettings();
    await refresh();
  });

  els.awarenessCampaignMode.addEventListener("change", async () => {
    lockCampaignModes("awareness");
    await saveDraftSettings();
    await refresh();
  });

  els.sendToNotAFit.addEventListener("change", saveDraftSettings);

  els.manualMode.addEventListener("change", async () => {
    lockSendModes("manual");
    await saveDraftSettings();
    await refresh();
  });

  els.autoMode.addEventListener("change", async () => {
    lockSendModes("auto");
    await saveDraftSettings();
    await refresh();
  });

  els.template.addEventListener("blur", saveDraftSettings);
  els.awarenessTemplate.addEventListener("blur", saveDraftSettings);
  els.startBtn.addEventListener("click", startMessaging);
  els.stopBtn.addEventListener("click", stopMessaging);
  els.resetBtn.addEventListener("click", resetSentList);
  if (els.closeModalBtn) els.closeModalBtn.addEventListener("click", closeMessageModal);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes[STORAGE_KEYS.state]) return;
    renderState(changes[STORAGE_KEYS.state].newValue || {});
  });
}

bindEvents();
refresh().catch((error) => {
  console.error("[LHM][popup] Failed to initialize popup:", error);
});
