import { VERIFY_NAME_URL } from "./config.js";

const DEFAULT_STATE = {
  running: false,
  status: "Stopped",
  sentCount: 0,
  currentCandidate: "-",
  mode: "manual",
  campaignMode: "message",
  template:
    "Hi {first_name}, thanks for applying for the {job_title} role. I would love to connect and share next steps.",
  awarenessTemplate:
    "Hi {first_name}, thanks for applying for the {job_title} role. I wanted to share a quick awareness note and next steps.",
  sessionStartAt: 0,
  maxPerSession: 25,
  sendToNotAFit: false
};

const STORAGE_KEYS = {
  state: "lhm_state",
  sentMap: "lhm_sent_map"
};

async function getState() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.state]);
  return { ...DEFAULT_STATE, ...(data[STORAGE_KEYS.state] || {}) };
}

async function setState(patch) {
  const prev = await getState();
  const next = { ...prev, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.state]: next });
  return next;
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get([STORAGE_KEYS.state, STORAGE_KEYS.sentMap]);
  if (!existing[STORAGE_KEYS.state]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.state]: DEFAULT_STATE });
  }
  if (!existing[STORAGE_KEYS.sentMap]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.sentMap]: {} });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || !message.type) {
      sendResponse({ ok: false, error: "Invalid message format." });
      return;
    }

    switch (message.type) {
      case "GET_STATE": {
        const state = await getState();
        sendResponse({ ok: true, state });
        break;
      }

      case "START_AUTOMATION": {
        const patch = {
          running: true,
          status: "Running",
          sentCount: 0,
          currentCandidate: "-",
          sessionStartAt: Date.now(),
          mode: message.payload?.mode === "auto" ? "auto" : "manual",
          campaignMode:
            message.payload?.campaignMode === "awareness" ? "awareness" : "message",
          template: message.payload?.template || DEFAULT_STATE.template,
          awarenessTemplate:
            message.payload?.awarenessTemplate || DEFAULT_STATE.awarenessTemplate,
          sendToNotAFit: Boolean(message.payload?.sendToNotAFit)
        };
        const state = await setState(patch);
        sendResponse({ ok: true, state });
        break;
      }

      case "STOP_AUTOMATION": {
        const state = await setState({ running: false, status: "Stopped" });
        sendResponse({ ok: true, state });
        break;
      }

      case "UPDATE_PROGRESS": {
        const payload = message.payload || {};
        const patch = {};
        if (typeof payload.sentCount === "number") patch.sentCount = payload.sentCount;
        if (typeof payload.status === "string") patch.status = payload.status;
        if (typeof payload.currentCandidate === "string") patch.currentCandidate = payload.currentCandidate;
        const state = await setState(patch);
        sendResponse({ ok: true, state });
        break;
      }

      case "RESET_SENT_LIST": {
        await chrome.storage.local.set({ [STORAGE_KEYS.sentMap]: {} });
        const state = await setState({ sentCount: 0, currentCandidate: "-", status: "Stopped" });
        sendResponse({ ok: true, state });
        break;
      }

      case "VERIFY_NAME": {
        const name = String(message.payload?.name || "").trim();
        if (!name) {
          sendResponse({ ok: false, isAwareness: false, error: "Missing name." });
          break;
        }

        try {
          const form = new FormData();
          form.append("name", name);

          const res = await fetch(VERIFY_NAME_URL, {
            method: "POST",
            body: form
          });

          if (!res.ok) {
            sendResponse({
              ok: false,
              isAwareness: false,
              error: `HTTP ${res.status}`
            });
            break;
          }

          const data = await res.json();
          sendResponse({ ok: true, isAwareness: data?.response === true });
        } catch (error) {
          console.error("[LHM][background] VERIFY_NAME failed:", error);
          sendResponse({
            ok: false,
            isAwareness: false,
            error: error?.message || "VERIFY_NAME request failed."
          });
        }
        break;
      }

      default:
        sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
    }
  })().catch((error) => {
    console.error("[LHM][background] Message handler error:", error);
    sendResponse({ ok: false, error: error?.message || "Unhandled background error." });
  });

  return true;
});
