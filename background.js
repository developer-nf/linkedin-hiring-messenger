import { VERIFY_NAME_URL } from "./config.js";

const DEFAULT_STATE = {
  running: false,
  status: "Stopped",
  sentCount: 0,
  currentCandidate: "-",
  mode: "manual",
  campaignMode: "message",
  pageSource: "applicants",
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
          pageSource:
            message.payload?.pageSource === "candidates" ? "candidates" : "applicants",
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
        if (typeof payload.currentCandidate === "string") {
          patch.currentCandidate = payload.currentCandidate;
        }
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

      case "GET_VERIFY_NAME_URL": {
        sendResponse({ ok: true, url: VERIFY_NAME_URL });
        break;
      }

      case "VERIFY_NAME": {
        const name = String(message.payload?.name || "").trim();
        if (!name) {
          sendResponse({ ok: false, isAwareness: false, error: "Missing name." });
          break;
        }

        const VERIFY_TIMEOUT_MS = 12000;
        const attemptVerify = async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
          try {
            // Prefer urlencoded over FormData — more reliable in MV3 service workers.
            const res = await fetch(VERIFY_NAME_URL, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                Accept: "application/json"
              },
              body: new URLSearchParams({ name }).toString(),
              signal: controller.signal,
              credentials: "omit",
              cache: "no-store"
            });
            if (!res.ok) {
              return { ok: false, isAwareness: false, error: `HTTP ${res.status}` };
            }
            const data = await res.json();
            return { ok: true, isAwareness: data?.response === true };
          } catch (error) {
            const aborted = error?.name === "AbortError";
            return {
              ok: false,
              isAwareness: false,
              error: aborted
                ? `VERIFY_NAME timed out after ${VERIFY_TIMEOUT_MS}ms`
                : error?.message || "VERIFY_NAME request failed."
            };
          } finally {
            clearTimeout(timer);
          }
        };

        let result = await attemptVerify();
        // Retry once for SW wake / transient network stalls (includes timeouts).
        if (!result.ok) {
          await new Promise((r) => setTimeout(r, 400));
          result = await attemptVerify();
        }
        if (!result.ok) {
          console.error("[LHM][background] VERIFY_NAME failed:", result.error);
        }
        sendResponse(result);
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
