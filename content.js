(() => {
  const U = window.LinkedInHiringUtils;
  if (!U?.isApplicantsPage()) return;

  const STORAGE_KEYS = {
    state: "lhm_state",
    sentMap: "lhm_sent_map"
  };

  const runtime = {
    stopRequested: false,
    isRunning: false
  };

  function log(...args) {
    console.log("[LHM][content]", ...args);
  }

  function isVisibleElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const view = el.ownerDocument?.defaultView || window;
    const style = view.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    return el.getClientRects().length > 0;
  }

  function getSearchDocuments() {
    const docs = [document];
    const seen = new Set([document]);
    const queue = [document];

    while (queue.length) {
      const current = queue.shift();
      const frames = current.querySelectorAll ? current.querySelectorAll("iframe") : [];
      for (const frame of frames) {
        try {
          const childDoc = frame.contentDocument;
          if (!childDoc || seen.has(childDoc)) continue;
          seen.add(childDoc);
          docs.push(childDoc);
          queue.push(childDoc);
        } catch (_error) {
          // Ignore cross-origin frame access errors.
        }
      }
    }

    return docs;
  }

  function queryAllAcrossDocuments(selector) {
    const docs = getSearchDocuments();
    const all = [];
    for (const doc of docs) {
      try {
        all.push(...Array.from(doc.querySelectorAll(selector)));
      } catch (_error) {
        // Ignore selector errors in inaccessible contexts.
      }
    }
    return all;
  }

  function queryAllAcrossDocumentsDeep(selector) {
    const docs = getSearchDocuments();
    const matches = [];
    const seenRoots = new Set();

    function searchRoot(root) {
      if (!root || seenRoots.has(root)) return;
      seenRoots.add(root);

      try {
        matches.push(...Array.from(root.querySelectorAll(selector)));
      } catch (_error) {
        // Ignore selector errors for unsupported contexts.
      }

      let allNodes = [];
      try {
        allNodes = Array.from(root.querySelectorAll("*"));
      } catch (_error) {
        allNodes = [];
      }

      for (const node of allNodes) {
        if (node.shadowRoot) {
          searchRoot(node.shadowRoot);
        }
      }
    }

    for (const doc of docs) {
      searchRoot(doc);
    }

    return matches;
  }

  function querySelectorIncludingShadow(root, selector) {
    if (!root || typeof root.querySelector !== "function") return null;
    const direct = root.querySelector(selector);
    if (direct) return direct;
    const walk = (node) => {
      if (!node) return null;
      try {
        for (const el of node.querySelectorAll("*")) {
          if (el.shadowRoot) {
            const inShadow = el.shadowRoot.querySelector(selector);
            if (inShadow) return inShadow;
            const deep = walk(el.shadowRoot);
            if (deep) return deep;
          }
        }
      } catch (_) {
        // Ignore access errors in closed or cross-origin shadow roots.
      }
      return null;
    };
    return walk(root);
  }

  function querySelectorAllIncludingShadow(root, selector) {
    const out = [];
    if (!root || typeof root.querySelectorAll !== "function") return out;
    try {
      out.push(...Array.from(root.querySelectorAll(selector)));
    } catch (_) {}
    const walk = (node) => {
      if (!node) return;
      try {
        for (const el of node.querySelectorAll("*")) {
          if (el.shadowRoot) {
            try {
              out.push(...Array.from(el.shadowRoot.querySelectorAll(selector)));
            } catch (_) {}
            walk(el.shadowRoot);
          }
        }
      } catch (_) {}
    };
    walk(root);
    return out;
  }

  function dispatchEscapeKey(target) {
    if (!target || !target.dispatchEvent) return;
    const doc = target.ownerDocument || target;
    const win = doc.defaultView || window;
    const opts = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true, view: win };
    try {
      target.dispatchEvent(new KeyboardEvent("keydown", opts));
      target.dispatchEvent(new KeyboardEvent("keyup", opts));
    } catch (_) {}
  }

  function getCandidateProfileUrl(card) {
    const profileAnchor = card.querySelector('a[href*="/in/"]');
    if (profileAnchor?.href) return profileAnchor.href;

    // New layout: applicant detail link (strip query params for stable key)
    const applicantLink =
      card.querySelector('a[href*="/applicants/"][href*="/detail/"]') ||
      card.querySelector('a[href*="/hiring/jobs/"]');
    if (applicantLink?.href) {
      try {
        const url = new URL(applicantLink.href, window.location.origin);
        return url.origin + url.pathname;
      } catch (_) {
        return applicantLink.href;
      }
    }

    return "";
  }

  function getApplicantListRoot() {
    return (
      document.querySelector('[data-testid="applicantListCollectionRef"]') ||
      document.querySelector('[role="list"][data-component-type="LazyColumn"]') ||
      document.querySelector('.hiring-applicants__list-container ul.artdeco-list') ||
      document.querySelector('.hiring-applicants__list-container')
    );
  }

  function getCandidateNameFromCard(card) {
    // New layout: name from entity lockup title
    const lockupTitle =
      card.querySelector('.artdeco-entity-lockup__title.hiring-people-card__title') ||
      card.querySelector('.artdeco-entity-lockup__title');
    if (lockupTitle?.textContent?.trim()) return lockupTitle.textContent.trim();

    const ariaNameEl = Array.from(card.querySelectorAll("[aria-label]")).find((el) => {
      const value = (el.getAttribute("aria-label") || "").trim();
      if (!value) return false;
      if (value.toLowerCase().includes("view full profile")) return false;
      // Candidate labels on this LinkedIn variant typically look like "Jane Doe" or "Jane Doe, Verified profile".
      return value.split(" ").length >= 2;
    });
    if (ariaNameEl) {
      const raw = ariaNameEl.getAttribute("aria-label") || "";
      return raw.replace(/,\s*verified profile/i, "").trim();
    }

    const strongText = card.querySelector("strong");
    if (strongText?.textContent?.trim()) return strongText.textContent.trim();
    const spans = Array.from(card.querySelectorAll("span"));
    const likely = spans.find((s) => (s.textContent || "").trim().split(" ").length >= 2);
    if (likely?.textContent?.trim()) return likely.textContent.trim();
    const paragraph = card.querySelector("p");
    if (paragraph?.textContent?.trim()) return paragraph.textContent.trim();
    return likely?.textContent?.trim() || "Candidate";
  }

  function getCandidateStableId(card) {
    const name = getCandidateNameFromCard(card);
    // New layout: metadata in entity lockup divs
    const metadataEls = card.querySelectorAll('.artdeco-entity-lockup__metadata');
    const headline = metadataEls[0]?.textContent?.trim() || card.querySelector("p:nth-of-type(2)")?.textContent?.trim() || "";
    const location = metadataEls[1]?.textContent?.trim() || card.querySelector("p:nth-of-type(3)")?.textContent?.trim() || "";
    return `${name}::${headline}::${location}`.toLowerCase();
  }

  function cardAlreadyMessaged(card) {
    const clampLines = Array.from(card.querySelectorAll('.lt-line-clamp__line'));
    return clampLines.some((span) => {
      const text = (span.textContent || "").trim().toLowerCase();
      return text.startsWith("message sent");
    });
  }

  function normalizePersonText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function isGenericComposerTitle(value) {
    const text = normalizePersonText(value).toLowerCase();
    if (!text) return true;
    const blocked = [
      "new message",
      "message",
      "messages",
      "compose",
      "compose message",
      "messaging",
      "linkedin",
      "candidate"
    ];
    return blocked.includes(text);
  }

  function looksLikePersonName(value) {
    const text = normalizePersonText(value);
    if (!text || isGenericComposerTitle(text)) return false;
    if (text.length < 2 || text.length > 80) return false;
    const words = text.split(" ").filter(Boolean);
    if (!words.length || words.length > 6) return false;
    // Allow names like "Abhi Pal" and "John A. Doe".
    return /^[a-zA-Z][a-zA-Z'.-]*(\s+[a-zA-Z][a-zA-Z'.-]*){0,5}$/.test(text);
  }

  function getJobTitleFromPanel() {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const cleanJobText = (value) =>
      normalize(value)
        .replace(/^applied for[:\s-]*/i, "")
        .replace(/^position[:\s-]*/i, "")
        .replace(/^job[:\s-]*/i, "")
        .replace(/^role[:\s-]*/i, "");

    const candidates = [];
    const scopedNodes = Array.from(document.querySelectorAll("[data-test-applicant-details], main, section, aside"));
    const roots = scopedNodes.length ? scopedNodes : [document.body];
    for (const root of roots) {
      const nodes = Array.from(root.querySelectorAll("h1, h2, h3, [aria-label], span, p, a"));
      for (const node of nodes) {
        const text = normalize(node.textContent || "");
        if (!text || text.length < 2 || text.length > 140) continue;
        const lower = text.toLowerCase();
        if (
          lower.includes("applied for") ||
          lower.includes("position") ||
          lower.includes("job title") ||
          lower.includes("role") ||
          (node.tagName === "A" && (node.getAttribute("href") || "").includes("/jobs/view/"))
        ) {
          const cleaned = cleanJobText(text);
          if (cleaned) candidates.push(cleaned);
        }
      }
    }

    const best = candidates.find((text) => !/^applied for$/i.test(text)) || candidates[0] || "";
    return best.slice(0, 120);
  }

  function deriveCandidateFirstName(cardName, fullName) {
    const pickSource = fullName && fullName !== "Candidate" ? fullName : cardName;
    const cleaned = (pickSource || "")
      .replace(/,\s*verified profile/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return "there";
    const firstToken = cleaned.split(" ")[0]?.trim() || "";
    return firstToken || "there";
  }

  function getSingleApplicantCardForDetailPage() {
    if (!U.isApplicantDetailPage()) return [];
    const candidateSignal =
      'a[href*="/in/"], a[href*="/talent/"], [role="button"][aria-label*="View full profile"], [data-test-applicant-name]';
    const detailRoot =
      document.querySelector("[data-test-applicant-details]") ||
      document.querySelector('[data-view-name="hiring-applicant-details"]') ||
      document.querySelector("main section") ||
      document.querySelector("main");
    if (!detailRoot) return [];
    const withSignal = detailRoot.querySelector(candidateSignal);
    if (!withSignal) return [];
    const card =
      withSignal.closest("[data-test-applicant-details]") ||
      withSignal.closest('[data-view-name="hiring-applicant-details"]') ||
      withSignal.closest("section") ||
      withSignal.closest("[role='region']") ||
      withSignal.closest("article") ||
      detailRoot;
    return card ? [card] : [];
  }

  function getCandidateCards() {
    // New layout: hiring applicants list items
    const hiringListItems = Array.from(document.querySelectorAll('li.hiring-applicants__list-item'));
    if (hiringListItems.length) {
      return hiringListItems.filter((li) => {
        const link = li.querySelector('a[href*="/applicants/"]');
        const name = li.querySelector('.artdeco-entity-lockup__title');
        return Boolean(link && name);
      });
    }

    const listRoot = getApplicantListRoot();
    if (listRoot) {
      const directCandidates = Array.from(listRoot.querySelectorAll(':scope > [role="button"][tabindex="0"]'))
        .filter((node) => {
          if (!(node instanceof HTMLElement)) return false;
          if (node.textContent?.toLowerCase().includes("load more")) return false;
          return Boolean(node.querySelector('[role="button"][aria-label*="View full profile"]'));
        });
      if (directCandidates.length) return directCandidates;
    }

    const seen = new Set();
    const cards = [];
    const selectors = [
      '[role="listitem"]',
      '[role="option"]',
      '[role="button"][tabindex="0"]',
      'li[data-test-applicant-card]',
      'li',
      "article"
    ];

    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (seen.has(node)) continue;
        const hasCandidateSignal = Boolean(
          node.querySelector(
            'a[href*="/in/"], a[href*="/talent/"], [role="button"][aria-label*="View full profile"], [data-test-applicant-name], a[href*="/applicants/"][href*="/detail/"]'
          )
        );
        if (!hasCandidateSignal) continue;

        seen.add(node);
        cards.push(node);
      }
    }

    if (cards.length) return cards;
    return getSingleApplicantCardForDetailPage();
  }

  function isShortlistControl(el) {
    if (!el) return false;
    const text = (el.textContent || "").trim().toLowerCase();
    const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
    const dataControl = (el.getAttribute("data-control-name") || "").trim().toLowerCase();
    return (
      text.includes("shortlist") ||
      aria.includes("shortlist") ||
      aria.includes("save") ||
      dataControl.includes("shortlist")
    );
  }

  async function openCandidateDetails(card) {
    // New layout: click the hiring applicant link directly
    const hiringApplicantLink = card.querySelector('a[href*="/applicants/"][href*="/detail/"]');
    if (hiringApplicantLink) {
      hiringApplicantLink.click();
      await U.sleep(U.randomInt(1000, 6000));
      return true;
    }

    const clickableSelectors = [
      '[data-test-applicant-name]',
      '[role="button"][aria-label*="View full profile"]',
      'a[href*="/in/"]',
      'a[href*="/talent/"]',
      "strong",
      "h3",
      "h4"
    ];

    for (const selector of clickableSelectors) {
      const nodes = Array.from(card.querySelectorAll(selector)).filter((node) => {
        if (!(node instanceof HTMLElement)) return false;
        if (!isVisibleElement(node)) return false;
        if (isShortlistControl(node)) return false;
        if (node.closest("button") && isShortlistControl(node.closest("button"))) return false;
        return true;
      });
      const target = nodes[0];
      if (!target) continue;

      const clickTarget = target.closest("button, a, [role='button']") || target;
      if (clickTarget instanceof HTMLElement) {
        clickTarget.click();
        await U.sleep(U.randomInt(1000, 6000));
        return true;
      }
    }

    // Last resort: click card only if no shortlist-like controls are present.
    const hasShortlistInCard = Boolean(
      Array.from(card.querySelectorAll("button, [role='button']")).find((el) => isShortlistControl(el))
    );
    if (!hasShortlistInCard) {
      card.click();
      await U.sleep(U.randomInt(1000, 6000));
      return true;
    }
    return false;
  }

  async function waitForCandidateCards() {
    const immediateCards = getCandidateCards();
    if (immediateCards.length) return immediateCards;

    await U.observeForElement({
      root: document,
      selector:
        '[data-testid="applicantListCollectionRef"] [role="button"][tabindex="0"], [role="listitem"], [role="option"], li[data-test-applicant-card], [data-test-applicant-name], li.hiring-applicants__list-item',
      timeoutMs: 15000
    });

    return U.retry(async () => {
      const cards = getCandidateCards();
      return cards.length ? cards : null;
    }, 3, 1200);
  }

  async function getState() {
    const data = await chrome.storage.local.get([STORAGE_KEYS.state]);
    return { sendToNotAFit: false, ...(data[STORAGE_KEYS.state] || {}) };
  }

  async function setStatePatch(patch) {
    const state = await getState();
    const next = { ...state, ...patch };
    await chrome.storage.local.set({ [STORAGE_KEYS.state]: next });
    return next;
  }

  async function getSentMap() {
    const data = await chrome.storage.local.get([STORAGE_KEYS.sentMap]);
    return data[STORAGE_KEYS.sentMap] || {};
  }

  async function setSentMap(map) {
    await chrome.storage.local.set({ [STORAGE_KEYS.sentMap]: map });
  }

  async function updateProgress(payload) {
    try {
      await chrome.runtime.sendMessage({ type: "UPDATE_PROGRESS", payload });
    } catch (error) {
      log("Unable to update progress via background:", error);
      await setStatePatch(payload);
    }
  }

  function assertNotStopped() {
    if (runtime.stopRequested) {
      const error = new Error("Stop requested");
      error.code = "STOP_REQUESTED";
      throw error;
    }
  }

  async function safeDelay() {
    assertNotStopped();
    U.randomScroll(window);
    await U.humanDelay(1000, 6000);
    assertNotStopped();
  }

  async function waitForRightPanelLoad() {
    // Wait for either contact button, message button, or details section to appear after card click.
    const panel = await U.observeForElement({
      root: document,
      selector:
        'button[data-view-name="hiring-applicant-contact"], button[data-view-name="hiring-applicant-contact-message"], button[aria-label*="Contact"], button[aria-label="Message"], [data-test-applicant-details], [role="region"], .hiring-applicant-header',
      timeoutMs: 12000
    });
    if (panel) return true;

    // Fallback: check if a visible "Message" button appeared in the panel
    const allBtns = Array.from(document.querySelectorAll('button'));
    const msgBtn = allBtns.find((btn) => {
      const text = (btn.textContent || "").trim().toLowerCase();
      return text === "message" && isVisibleElement(btn);
    });
    return Boolean(msgBtn);
  }

  async function findContactButton() {
    return U.retry(async () => {
      for (const root of getApplicantHeaderRoots()) {
        const hiringContactBtn = root.querySelector('button[data-view-name="hiring-applicant-contact"]');
        if (hiringContactBtn && isVisibleElement(hiringContactBtn)) return hiringContactBtn;

        const ariaButton = root.querySelector('button[aria-label*="Contact"]');
        if (ariaButton && isVisibleElement(ariaButton)) return ariaButton;

        const btns = Array.from(root.querySelectorAll("button")).filter(isVisibleElement);
        const contactByText = btns.find((btn) => {
          const text = (btn.textContent || "").trim().toLowerCase();
          return text === "contact";
        });
        if (contactByText) return contactByText;
      }
      return null;
    }, 3, 1000);
  }

  function findMessageOptionInMenu(menu) {
    if (!menu) return null;
    const menuItems = Array.from(
      menu.querySelectorAll("button, [role='menuitem'], a, div[role='button'], div.artdeco-dropdown__item, li")
    );
    const messageItem = menuItems.find((item) => {
      const text = (item.textContent || "").trim().toLowerCase();
      if (!(text === "message" || text.includes("message"))) return false;
      if (text.includes("share")) return false;
      return true;
    });
    return messageItem || null;
  }

  async function findMessageMenuOption() {
    return U.retry(async () => {
      const docs = getSearchDocuments();
      for (const doc of docs) {
        try {
          const menu =
            doc.querySelector('div[role="menu"]') ||
            querySelectorIncludingShadow(doc.body || doc.documentElement, 'div[role="menu"]') ||
            querySelectorIncludingShadow(doc.body || doc.documentElement, '[role="listbox"]');
          const messageItem = findMessageOptionInMenu(menu);
          if (messageItem && isVisibleElement(messageItem)) return messageItem;
        } catch (_) {}
      }

      const composeLinks = queryAllAcrossDocumentsDeep('a[href*="/messaging/compose/"]');
      const withOverlay = composeLinks.filter((el) => {
        const href = el.getAttribute("href") || "";
        if (!href.includes("interop=msgOverlay") && !href.includes("messaging/compose")) return false;
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        if (aria.includes("share job application")) return false;
        return isVisibleElement(el);
      });
      if (withOverlay.length) return withOverlay[0];

      for (const doc of docs) {
        try {
          const root = doc.body || doc.documentElement || doc;
          const candidates = querySelectorAllIncludingShadow(root, "button, a, div[role='menuitem'], div[role='button'], [role='menuitem']");
          const visible = candidates.filter((el) => isVisibleElement(el));
          const messageEl = visible.find((el) => {
            const text = (el.textContent || "").trim().toLowerCase();
            if (!(text === "message" || text.includes("message"))) return false;
            if (text.includes("share")) return false;
            const href = el.getAttribute("href") || "";
            if (href.includes("/messaging/compose/") && href.includes("subject=")) return false;
            return true;
          });
          if (messageEl) return messageEl;
        } catch (_) {}
      }
      return null;
    }, 5, 800);
  }

  function getApplicantHeaderRoots() {
    return [
      document.querySelector(".hiring-applicant-header"),
      document.querySelector("[data-test-applicant-details]"),
      document.querySelector('[data-view-name="hiring-applicant-details"]'),
      document.querySelector("main section"),
      document.querySelector("main")
    ].filter(Boolean);
  }

  async function openMessageViaMoreMenu() {
    const moreButton = await findMoreButtonInHeader();
    if (!moreButton) {
      throw new Error("More button not found for Not a fit applicant.");
    }

    const existingEditors = new Set(getAllComposerEditors());
    const editorWatchPromise = watchForMessageEditor(30000);
    moreButton.click();
    await safeDelay();

    const messageOption = await findMessageInMoreDropdown();
    if (!messageOption) {
      throw new Error("Message option in More menu was not found.");
    }
    log("Clicking Message in More menu:", (messageOption.textContent || "").trim());
    messageOption.click();
    await U.sleep(U.randomInt(1000, 6000));

    return (
      (await waitForEditorForCurrentApplicant(30000, 250, existingEditors)) ||
      (await waitForLinkedInMessageTextbox(30000, 250)) ||
      (await editorWatchPromise) ||
      (await waitForMessageComposer(30000, 250))
    );
  }

  async function handleMissingContactMessage(cardName, candidateKey) {
    const state = await getState();
    if (!Boolean(state.sendToNotAFit)) {
      log("Skipping — no Contact/Message found (Not a fit disabled):", cardName);
      return {
        skipped: true,
        sent: false,
        profileUrl: candidateKey,
        cardName,
        reason: "not a fit disabled"
      };
    }

    try {
      log("No Contact/Message found — opening via More menu");
      const editor = await openMessageViaMoreMenu();
      return { skipped: false, editor };
    } catch (error) {
      log("More menu failed for Not a fit applicant, skipping:", cardName, error?.message);
      return {
        skipped: true,
        sent: false,
        profileUrl: candidateKey,
        cardName,
        reason: "not a fit disabled"
      };
    }
  }

  function isMoreButton(btn) {
    if (!btn || !isVisibleElement(btn)) return false;

    const visibleLabel = (btn.querySelector('[aria-hidden="true"]')?.textContent || "").trim().toLowerCase().replace(/…/g, "...");
    const a11yLabel = (btn.querySelector(".a11y-text")?.textContent || "").trim().toLowerCase();
    const ariaLabel = (btn.getAttribute("aria-label") || "").trim().toLowerCase();

    if (a11yLabel.includes("see more options") || a11yLabel.includes("more options")) return true;
    if (ariaLabel.includes("more options") || ariaLabel.includes("more actions")) return true;

    if (visibleLabel === "more" || visibleLabel === "more..." || /^more\.+$/.test(visibleLabel)) return true;
    if (visibleLabel.startsWith("more")) return true;

    // Fallback when label spans are flattened (e.g. "more...see more options").
    const flatText = (btn.textContent || "").trim().toLowerCase().replace(/…/g, "...");
    if (flatText.includes("see more options") || /^more\.+/.test(flatText)) return true;

    if (btn.classList.contains("artdeco-dropdown__trigger") && flatText.includes("more")) return true;
    return false;
  }

  async function findMoreButtonInHeader() {
    return U.retry(async () => {
      const scopedSelectors = [
        "#hiring-detail-root .hiring-applicant-header .display-flex.justify-space-between button.artdeco-dropdown__trigger",
        "#hiring-detail-root .hiring-applicant-header button.artdeco-dropdown__trigger",
        "#hiring-detail-root button.artdeco-dropdown__trigger",
        ".hiring-applicant-header-actions button.artdeco-dropdown__trigger",
        ".hiring-applicant-header button.artdeco-dropdown__trigger",
        '[data-view-name="hiring-applicant-details"] button.artdeco-dropdown__trigger'
      ];

      for (const selector of scopedSelectors) {
        const triggers = queryAllAcrossDocumentsDeep(selector).filter(isVisibleElement);
        const moreBtn = triggers.find(isMoreButton);
        if (moreBtn) return moreBtn;
      }

      for (const root of getApplicantHeaderRoots()) {
        const btns = Array.from(
          root.querySelectorAll('button.artdeco-dropdown__trigger, button[aria-expanded], button, [role="button"]')
        );
        const moreBtn = btns.find(isMoreButton);
        if (moreBtn) return moreBtn;
      }

      const allTriggers = queryAllAcrossDocumentsDeep("button.artdeco-dropdown__trigger").filter(isVisibleElement);
      return allTriggers.find(isMoreButton) || null;
    }, 5, 800);
  }

  async function findMessageInMoreDropdown() {
    return U.retry(async () => {
      const dropdowns = queryAllAcrossDocumentsDeep(".artdeco-dropdown__content-inner");
      for (const dropdown of dropdowns) {
        if (!isVisibleElement(dropdown)) continue;

        const messageBtn = dropdown.querySelector('button[data-view-name="hiring-applicant-contact-message"]');
        if (messageBtn && isVisibleElement(messageBtn)) return messageBtn;

        const messageItem = findMessageOptionInMenu(dropdown);
        if (messageItem && isVisibleElement(messageItem)) return messageItem;
      }
      return null;
    }, 5, 800);
  }

  function findMessageComposer() {
    const selectors = [
      // Modal layout
      'div[role="dialog"] .msg-form__contenteditable[contenteditable="true"]',
      'div[role="dialog"] div[contenteditable="true"][role="textbox"]',
      // Inline/right-panel layout
      '.msg-form__contenteditable[contenteditable="true"][role="textbox"]',
      '.msg-form__contenteditable[contenteditable="true"][aria-multiline="true"]',
      '.msg-form__contenteditable[contenteditable="true"]',
      '.msg-form [contenteditable="true"][role="textbox"]',
      // Generic fallback
      'div[contenteditable="true"][role="textbox"][aria-label*="Write a message"]',
      'div[contenteditable="true"][role="textbox"][aria-multiline="true"]',
      'div[contenteditable="true"][role="textbox"]'
    ];

    for (const selector of selectors) {
      const all = queryAllAcrossDocumentsDeep(selector);
      if (!all.length) continue;

      // Prefer visible nodes but support hidden/staged nodes as fallback.
      const visible = all.find((el) => isVisibleElement(el));
      if (visible) return visible;
      return all[all.length - 1];
    }

    // Heuristic fallback for LinkedIn variants where class/labels differ.
    const contentEditables = queryAllAcrossDocumentsDeep('div[contenteditable="true"]');
    const ranked = contentEditables
      .map((el) => {
        const className = (el.className || "").toString();
        const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
        const role = (el.getAttribute("role") || "").toLowerCase();
        const ariaMultiline = (el.getAttribute("aria-multiline") || "").toLowerCase();
        const form = el.closest("form.msg-form") || el.closest("form");
        const sendButton =
          form?.querySelector("button.msg-form__send-button, button[type='submit']") || null;
        const score =
          (className.includes("msg-form__contenteditable") ? 5 : 0) +
          ((role === "textbox" || ariaMultiline === "true") ? 4 : 0) +
          ((ariaLabel.includes("write a message") || ariaLabel.includes("message")) ? 2 : 0) +
          (form ? 2 : 0) +
          (sendButton ? 4 : 0) +
          (isVisibleElement(el) ? 2 : 0);
        return { el, score };
      })
      .filter((entry) => entry.score >= 7)
      .sort((a, b) => b.score - a.score);
    if (ranked.length) return ranked[0].el;

    return null;
  }

  async function waitForMessageComposer(timeoutMs = 30000, pollMs = 250) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const composer = findMessageComposer();
      if (composer) return composer;
      await U.sleep(pollMs);
    }
    return null;
  }

  async function waitForLinkedInMessageTextbox(timeoutMs = 30000, pollMs = 250) {
    const selector =
      '.msg-form__contenteditable[contenteditable="true"][role="textbox"][aria-label*="Write a message"], .msg-form__contenteditable[contenteditable="true"][role="textbox"], .msg-form__contenteditable[contenteditable="true"][aria-multiline="true"], div[contenteditable="true"][role="textbox"][aria-multiline="true"]';
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const matches = queryAllAcrossDocumentsDeep(selector);
      if (matches.length) {
        const visible = matches.find((el) => isVisibleElement(el));
        return visible || matches[matches.length - 1];
      }
      await U.sleep(pollMs);
    }
    return null;
  }

  async function findMessageDialog() {
    await U.observeForElement({
      root: document,
      selector:
        'div[role="dialog"], div.msg-overlay-conversation-bubble, section.msg-overlay-conversation-bubble, .msg-form, .msg-form [contenteditable="true"], .msg-form__contenteditable[contenteditable="true"], div[contenteditable="true"][aria-label*="Write a message"]',
      timeoutMs: 12000
    });

    return U.retry(async () => {
      const activeBubble =
        document.querySelector(
          'div.msg-overlay-conversation-bubble--is-active[role="dialog"][data-view-name="message-overlay-conversation-bubble-item"]'
        ) ||
        document.querySelector('div.msg-overlay-conversation-bubble--is-active[role="dialog"]');
      if (isVisibleElement(activeBubble)) return activeBubble;

      const candidates = [
        ...Array.from(document.querySelectorAll('div[role="dialog"]')),
        ...Array.from(document.querySelectorAll("div.msg-overlay-conversation-bubble")),
        ...Array.from(document.querySelectorAll("section.msg-overlay-conversation-bubble")),
        ...Array.from(document.querySelectorAll(".msg-form"))
      ].filter((el) => isVisibleElement(el));

      if (candidates.length) return candidates[0];

      const editorCandidates = Array.from(
        document.querySelectorAll(
          '.msg-form__contenteditable[contenteditable="true"], .msg-form [contenteditable="true"], div[contenteditable="true"][aria-label*="Write a message"], div[contenteditable="true"][role="textbox"]'
        )
      );
      const editor = editorCandidates.find((el) => {
        if (!isVisibleElement(el)) return false;
        const text = (el.getAttribute("aria-label") || "").toLowerCase();
        return text.includes("write a message") || el.className.includes("msg-form");
      });
      if (!editor || !(editor instanceof HTMLElement)) return null;

      return (
        editor.closest(".msg-form") ||
        editor.closest("div.msg-overlay-conversation-bubble") ||
        editor.closest("section.msg-overlay-conversation-bubble") ||
        editor.closest('div[role="dialog"]') ||
        editor.closest("section") ||
        editor.closest("div")
      );
    }, 3, 600);
  }

  function findMessageEditor(dialog) {
    const activeDialog =
      document.querySelector(
        'div.msg-overlay-conversation-bubble--is-active[role="dialog"][data-view-name="message-overlay-conversation-bubble-item"]'
      ) || document.querySelector('div.msg-overlay-conversation-bubble--is-active[role="dialog"]');

    const queryRoots = [activeDialog, dialog, document];
    for (const root of queryRoots) {
      if (!root || !(root instanceof Element || root instanceof Document)) continue;
      const preferred = Array.from(
        root.querySelectorAll(
          '.msg-form__contenteditable[contenteditable="true"][role="textbox"][aria-label*="Write a message"], .msg-form__contenteditable[contenteditable="true"][role="textbox"], .msg-form [contenteditable="true"][role="textbox"], div[contenteditable="true"][role="textbox"][aria-label*="Write a message"]'
        )
      ).find((el) => isVisibleElement(el));
      if (preferred) return preferred;
    }

    const preferred = Array.from(
      dialog.querySelectorAll(
        '.msg-form__contenteditable[contenteditable="true"], .msg-form [contenteditable="true"], div[contenteditable="true"][role="textbox"]'
      )
    ).find((el) => isVisibleElement(el));
    if (preferred) return preferred;

    const fallback = Array.from(dialog.querySelectorAll('div[contenteditable="true"]')).find((el) =>
      isVisibleElement(el)
    );
    return fallback || null;
  }

  async function findMessageEditorGlobal() {
    return U.retry(async () => {
      const activeBubble = document.querySelector(
        'div.msg-overlay-conversation-bubble--is-active[role="dialog"]'
      );
      if (activeBubble instanceof Element) {
        const bubbleEditor = activeBubble.querySelector(
          '.msg-form__contenteditable[contenteditable="true"], .msg-form [contenteditable="true"]'
        );
        if (bubbleEditor) return bubbleEditor;
      }

      const allEditors = Array.from(
        document.querySelectorAll(
          '.msg-form__contenteditable[contenteditable="true"], .msg-form [contenteditable="true"], div[contenteditable="true"][aria-label*="Write a message"]'
        )
      );
      if (!allEditors.length) return null;

      const visibleEditor = allEditors.find((el) => isVisibleElement(el));
      return visibleEditor || allEditors[allEditors.length - 1] || null;
    }, 14, 500);
  }

  function getAllComposerEditors() {
    return queryAllAcrossDocuments(
      '.msg-form__contenteditable[contenteditable="true"], .msg-form [contenteditable="true"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"][aria-label*="Write a message"]'
    );
  }

  function getEditorInActiveBubble() {
    const docs = getSearchDocuments();
    for (const doc of docs) {
      try {
        const root = doc.body || doc.documentElement || doc;
        const activeBubble = querySelectorIncludingShadow(
          root,
          'div.msg-overlay-conversation-bubble--is-active[role="dialog"], div.msg-overlay-conversation-bubble--is-active'
        );
        if (!activeBubble) continue;
        const editor =
          activeBubble.querySelector('.msg-form__contenteditable[contenteditable="true"]') ||
          activeBubble.querySelector('.msg-form [contenteditable="true"][role="textbox"]') ||
          activeBubble.querySelector('div[contenteditable="true"][role="textbox"]') ||
          activeBubble.querySelector('div[contenteditable="true"]');
        if (editor && isVisibleElement(editor)) return editor;
        if (editor) return editor;
      } catch (_) {}
    }
    return null;
  }

  async function waitForEditorForCurrentApplicant(timeoutMs, pollMs, existingEditorSet) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const activeEditor = getEditorInActiveBubble();
      if (activeEditor && !existingEditorSet.has(activeEditor)) return activeEditor;

      const allEditors = getAllComposerEditors();
      const newEditor = allEditors.find((ed) => !existingEditorSet.has(ed));
      if (newEditor) return newEditor;

      if (allEditors.length > 0 && existingEditorSet.size === 0) return allEditors[allEditors.length - 1];

      await U.sleep(pollMs);
    }
    const allEditors = getAllComposerEditors();
    const newEditor = allEditors.find((ed) => !existingEditorSet.has(ed));
    if (newEditor) return newEditor;
    if (allEditors.length) return allEditors[allEditors.length - 1];
    return null;
  }

  function pickBestComposerEditor(candidates) {
    if (!candidates.length) return null;

    // Prefer editors inside LinkedIn compose form with a Send button nearby.
    const scored = candidates
      .map((editor) => {
        const form = editor.closest("form.msg-form");
        const sendInForm =
          form?.querySelector("button.msg-form__send-button, button[type='submit']") || null;
        const score =
          (form ? 5 : 0) +
          (sendInForm ? 5 : 0) +
          (isVisibleElement(editor) ? 2 : 0) +
          ((editor.getAttribute("aria-label") || "").toLowerCase().includes("write a message") ? 1 : 0);
        return { editor, score };
      })
      .sort((a, b) => b.score - a.score);

    return scored[0]?.editor || candidates[candidates.length - 1] || null;
  }

  function findEditorFromSendButton() {
    const sendButtons = queryAllAcrossDocuments("button.msg-form__send-button, button[type='submit']");
    for (const button of sendButtons) {
      const form = button.closest("form.msg-form") || button.closest("form");
      if (!form) continue;
      const editor =
        form.querySelector('.msg-form__contenteditable[contenteditable="true"]') ||
        form.querySelector('div[contenteditable="true"][role="textbox"]') ||
        form.querySelector('div[contenteditable="true"]');
      if (editor) return editor;
    }
    return null;
  }

  async function waitForComposerEditor() {
    await U.observeForElement({
      root: document,
      selector:
        'div.msg-overlay-conversation-bubble[role="dialog"] .msg-form__contenteditable[contenteditable="true"], .msg-form__contenteditable[contenteditable="true"], .msg-form [contenteditable="true"]',
      timeoutMs: 20000
    });

    let editor = await findMessageEditorGlobal();
    if (editor) return editor;

    editor = findEditorFromSendButton();
    if (editor) return editor;

    // Last-resort fallback without visibility gating.
    const allEditors = getAllComposerEditors();
    editor = pickBestComposerEditor(allEditors);
    return editor || null;
  }

  async function waitForPrimaryMessageEditor() {
    await U.observeForElement({
      root: document,
      selector:
        '.msg-form__contenteditable[contenteditable="true"][role="textbox"], .msg-form__contenteditable[contenteditable="true"]',
      timeoutMs: 25000
    });

    return U.retry(async () => {
      const exact = Array.from(
        document.querySelectorAll(
          '.msg-form__contenteditable[contenteditable="true"][role="textbox"][aria-label*="Write a message"], .msg-form__contenteditable[contenteditable="true"][role="textbox"], .msg-form__contenteditable[contenteditable="true"]'
        )
      );
      if (!exact.length) return null;

      // Prefer visible instance, otherwise use most recent mounted editor.
      const visible = exact.find((el) => isVisibleElement(el));
      return visible || exact[exact.length - 1] || null;
    }, 12, 500);
  }

  function findAnyMessageEditorNow() {
    const selectors = [
      '.msg-form__contenteditable[contenteditable="true"]',
      '.msg-form [contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][aria-label*="Write a message"]',
      'div[contenteditable="true"]'
    ];
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      if (!nodes.length) continue;
      const preferred = nodes.find((node) => isVisibleElement(node)) || nodes[nodes.length - 1];
      if (preferred) return preferred;
    }
    return null;
  }

  function watchForMessageEditor(timeoutMs = 30000) {
    const immediate = findAnyMessageEditorNow();
    if (immediate) return Promise.resolve(immediate);

    return waitForMessageComposer(timeoutMs, 200);
  }

  function findSendButton(root, editor) {
    const formRoot = editor?.closest("form.msg-form") || root;
    return (
      formRoot?.querySelector('button[type="submit"]') ||
      formRoot?.querySelector("button.msg-form__send-button") ||
      Array.from(formRoot?.querySelectorAll("button") || []).find((btn) =>
        (btn.textContent || "").trim().toLowerCase().includes("send")
      ) ||
      null
    );
  }

  function extractNameFromDialog(dialog) {
    if (!dialog) return "";
    const selectors = [
      // Recipient chips/typeahead in "New message" composer
      '.msg-connections-typeahead__top-fixed-section span[dir="ltr"]',
      '.msg-connections-typeahead__top-fixed-section span',
      // Conversation header/lockup variants
      "[data-test-entity-lockup-title]",
      ".artdeco-entity-lockup__title",
      ".msg-overlay-bubble-header__title",
      // Generic fallback
      "h1, h2, h3, header span, [data-test-modal-title]"
    ];

    for (const selector of selectors) {
      const nodes = Array.from(dialog.querySelectorAll(selector));
      for (const node of nodes) {
        const text = normalizePersonText(node.textContent || "");
        if (looksLikePersonName(text)) return text;
      }
    }
    return "";
  }

  function pickBestCandidateName(cardName, dialogName) {
    const card = normalizePersonText(cardName).replace(/,\s*verified profile/i, "");
    const dialog = normalizePersonText(dialogName).replace(/,\s*verified profile/i, "");
    if (looksLikePersonName(card)) return card;
    if (looksLikePersonName(dialog)) return dialog;
    if (card && !isGenericComposerTitle(card)) return card;
    if (dialog && !isGenericComposerTitle(dialog)) return dialog;
    return "Candidate";
  }

  function highlightButton(button) {
    button.style.outline = "3px solid #22c55e";
    button.style.boxShadow = "0 0 0 4px rgba(34, 197, 94, 0.25)";
  }

  async function waitForUserSendOrClose(dialog, timeoutMs = 120000) {
    const sendButton =
      dialog.querySelector('button[type="submit"]') ||
      dialog.querySelector("button.msg-form__send-button") ||
      Array.from(dialog.querySelectorAll("button")).find((btn) =>
        (btn.textContent || "").trim().toLowerCase().includes("send")
      );
    if (!sendButton) return false;

    highlightButton(sendButton);
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      assertNotStopped();
      const stillOpen = document.body.contains(dialog);
      if (!stillOpen) return true;
      await U.sleep(500);
    }
    return false;
  }

  function resolveComposerContainer(dialog, editor) {
    const findAncestorWithHeaderControls = (start) => {
      let node = start instanceof Element ? start : null;
      while (node && node !== document.body) {
        if (node.querySelector?.(".msg-overlay-bubble-header__controls")) return node;
        node = node.parentElement;
      }
      return null;
    };

    const fromDialog =
      dialog?.closest("div.msg-overlay-conversation-bubble") ||
      dialog?.closest("section.msg-overlay-conversation-bubble") ||
      findAncestorWithHeaderControls(dialog) ||
      dialog?.closest(".msg-overlay-bubble-header")?.closest("section, div") ||
      dialog?.closest('[data-view-name*="message-overlay"]') ||
      dialog?.closest('div[role="dialog"]') ||
      null;
    if (fromDialog) return fromDialog;

    const fromEditor =
      editor?.closest("div.msg-overlay-conversation-bubble") ||
      editor?.closest("section.msg-overlay-conversation-bubble") ||
      findAncestorWithHeaderControls(editor) ||
      editor?.closest(".msg-overlay-bubble-header")?.closest("section, div") ||
      editor?.closest('[data-view-name*="message-overlay"]') ||
      editor?.closest('div[role="dialog"]') ||
      editor?.closest("form.msg-form") ||
      null;
    return fromEditor;
  }

  function isElementOpenAndVisible(el) {
    return Boolean(el && document.body.contains(el) && isVisibleElement(el));
  }

  function isComposerStillOpen(container, dialog, editor) {
    if (isElementOpenAndVisible(container)) return true;
    if (isElementOpenAndVisible(dialog)) return true;
    if (isElementOpenAndVisible(editor)) return true;
    return false;
  }

  function forceClick(element) {
    if (!element) return;
    try {
      if (typeof element.focus === "function") element.focus();
    } catch (_) {}
    const rect = element.getBoundingClientRect?.();
    const x = rect ? rect.left + (rect.width || 0) / 2 : 0;
    const y = rect ? rect.top + (rect.height || 0) / 2 : 0;
    const opts = { bubbles: true, cancelable: true, view: element.ownerDocument?.defaultView || window, clientX: x, clientY: y };
    element.dispatchEvent(new MouseEvent("mousedown", opts));
    element.dispatchEvent(new MouseEvent("mouseup", opts));
    element.dispatchEvent(new MouseEvent("click", opts));
    try {
      element.click();
    } catch (_) {}
  }

  function getCloseButtonFromHeader(headerControls) {
    if (!headerControls) return null;
    const headerButtons = Array.from(headerControls.querySelectorAll("button.msg-overlay-bubble-header__control, button"));
    const exactClose = headerButtons.find((btn) => {
      const text = (btn.textContent || "").trim().toLowerCase();
      const iconType = btn.querySelector("svg[data-test-icon]")?.getAttribute("data-test-icon")?.toLowerCase() || "";
      return (
        iconType.includes("close") ||
        text.includes("close your draft conversation") ||
        text.includes("close your conversation")
      );
    });
    if (exactClose) return exactClose;
    if (headerButtons.length >= 2) return headerButtons[1];
    return null;
  }

  function findComposerCloseButtonInAllDocuments() {
    const docs = getSearchDocuments();
    for (const doc of docs) {
      try {
        const root = doc.body || doc.documentElement || doc;
        const headerControls = querySelectorIncludingShadow(root, ".msg-overlay-bubble-header__controls");
        const btn = getCloseButtonFromHeader(headerControls);
        if (btn) return btn;
      } catch (_) {
        // Skip inaccessible documents (e.g. cross-origin iframes).
      }
    }
    return null;
  }

  function findCloseButtonByAriaInAllDocuments() {
    const docs = getSearchDocuments();
    for (const doc of docs) {
      try {
        const root = doc.body || doc.documentElement || doc;
        const buttons = querySelectorAllIncludingShadow(root, "button");
        const closeBtn = buttons.find((btn) => {
          const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
          const title = (btn.getAttribute("title") || "").toLowerCase();
          return (
            aria.includes("close your conversation") ||
            aria.includes("close your draft") ||
            aria.includes("close conversation") ||
            (aria.includes("close") && !aria.includes("minimize")) ||
            title.includes("close")
          );
        });
        if (closeBtn) return closeBtn;
      } catch (_) {}
    }
    return null;
  }

  function hideOverlayLastResort() {
    const docs = getSearchDocuments();
    const overlaySelectors = [
      ".msg-overlay-conversation-bubble--is-active",
      "div.msg-overlay-conversation-bubble[role='dialog']",
      "section.msg-overlay-conversation-bubble",
      "div[role='dialog'][class*='msg-overlay']"
    ];
    for (const doc of docs) {
      try {
        const root = doc.body || doc.documentElement || doc;
        for (const sel of overlaySelectors) {
          const el = querySelectorIncludingShadow(root, sel);
          if (el && el.getBoundingClientRect?.().width > 0) {
            el.setAttribute("data-lhm-hidden", "1");
            el.style.setProperty("display", "none", "important");
            return true;
          }
        }
      } catch (_) {}
    }
    return false;
  }

  function findComposerCloseButton(container) {
    const root = container || document;
    const headerControls = querySelectorIncludingShadow(root, ".msg-overlay-bubble-header__controls");
    let closeBtn = getCloseButtonFromHeader(headerControls);
    if (closeBtn) return closeBtn;

    closeBtn = findComposerCloseButtonInAllDocuments();
    if (closeBtn) return closeBtn;

    const allButtons = Array.from(root.querySelectorAll("button"));
    if (!allButtons.length) return null;

    const scored = allButtons
      .map((btn) => {
        const text = (btn.textContent || "").trim().toLowerCase();
        const aria = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
        const controlName = (btn.getAttribute("data-control-name") || "").trim().toLowerCase();
        const iconType =
          btn.querySelector("svg[data-test-icon]")?.getAttribute("data-test-icon")?.toLowerCase() ||
          btn.querySelector("li-icon[type]")?.getAttribute("type")?.toLowerCase() ||
          "";
        const inHeader = Boolean(btn.closest(".msg-overlay-bubble-header__controls, .msg-overlay-bubble-header"));
        const closeLike =
          text.includes("close your draft conversation") ||
          text.includes("close conversation") ||
          text.includes("close") ||
          aria.includes("close your draft conversation") ||
          aria.includes("close your conversation") ||
          aria.includes("close") ||
          controlName.includes("overlay.close") ||
          iconType.includes("close");
        const minimizeLike =
          text.includes("minimize") ||
          aria.includes("minimize") ||
          controlName.includes("overlay.minimize") ||
          iconType.includes("minimize");

        const score =
          (inHeader ? 3 : 0) +
          (closeLike ? 20 : 0) +
          (minimizeLike ? -4 : 0) +
          (text.includes("draft") || aria.includes("draft") ? 5 : 0);
        return { btn, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored[0]?.btn || null;
  }

  function clickDiscardDraftIfPrompted() {
    const docs = getSearchDocuments();
    for (const doc of docs) {
      try {
        const root = doc.body || doc.documentElement || doc;
        const buttons = querySelectorAllIncludingShadow(root, "button");
        const discardBtn = buttons.find((btn) => {
          const text = (btn.textContent || "").trim().toLowerCase();
          const aria = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
          return (
            text === "discard" ||
            text.includes("discard draft") ||
            text.includes("discard message") ||
            aria.includes("discard")
          );
        });
        if (discardBtn) {
          forceClick(discardBtn);
          return true;
        }
      } catch (_) {}
    }
    return false;
  }

  function hasExistingConversationMessages(dialog, editor) {
    const container = resolveComposerContainer(dialog, editor) || dialog || editor;
    if (!container || container === document) return false;

    const threadSelectors = [
      ".msg-s-message-list__event",
      ".msg-s-message-group",
      ".msg-s-event-listitem",
      ".msg-overlay-conversation-bubble__message-list li",
      ".msg-s-message-list-content",
      '[data-view-name*="message-thread"] [role="listitem"]'
    ];

    const hasThreadEvents = threadSelectors.some((selector) => {
      const nodes = Array.from(container.querySelectorAll(selector));
      return nodes.some((node) => isVisibleElement(node) && (node.textContent || "").trim().length > 0);
    });
    return hasThreadEvents;
  }

  async function closeAnyOpenComposer(timeoutMs = 3500) {
    const editor = findAnyMessageEditorNow();
    const dialog = editor
      ? editor.closest('div[role="dialog"]') ||
        editor.closest("div.msg-overlay-conversation-bubble") ||
        editor.closest("section.msg-overlay-conversation-bubble") ||
        editor.closest("form.msg-form") ||
        null
      : document.querySelector(
          'div.msg-overlay-conversation-bubble--is-active[role="dialog"], div.msg-overlay-conversation-bubble[role="dialog"], section.msg-overlay-conversation-bubble[role="dialog"], div[role="dialog"]'
        );
    if (!dialog && !editor) return true;
    return closeDialog(dialog, editor, timeoutMs);
  }

  async function closeDialog(dialog, editor, timeoutMs = 5000) {
    let container = resolveComposerContainer(dialog, editor);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      container = resolveComposerContainer(dialog, editor) || container;
      if (!isComposerStillOpen(container, dialog, editor)) return true;

      dispatchEscapeKey(container?.ownerDocument?.documentElement || document.documentElement);
      if (container) dispatchEscapeKey(container);
      await U.sleep(100);

      let closeBtn = findComposerCloseButton(container) || findComposerCloseButton(document);
      if (!closeBtn) closeBtn = findComposerCloseButtonInAllDocuments();
      if (!closeBtn) closeBtn = findCloseButtonByAriaInAllDocuments();

      if (closeBtn) {
        forceClick(closeBtn);
        clickDiscardDraftIfPrompted();
      } else {
        const docs = getSearchDocuments();
        for (const doc of docs) {
          try {
            const root = doc.body || doc.documentElement || doc;
            const headerControls = querySelectorIncludingShadow(root, ".msg-overlay-bubble-header__controls");
            const fallbackClose = getCloseButtonFromHeader(headerControls);
            if (fallbackClose) {
              forceClick(fallbackClose);
              break;
            }
          } catch (_) {}
        }
        clickDiscardDraftIfPrompted();
      }

      await U.sleep(350);
      if (!isComposerStillOpen(container, dialog, editor)) return true;
    }

    if (isComposerStillOpen(container, dialog, editor)) {
      hideOverlayLastResort();
    }
    return !isComposerStillOpen(container, dialog, editor);
  }

  async function verifyNameForAwareness(applicantName) {
    const name = String(applicantName || "").trim();
    if (!name || name === "Candidate") return false;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "VERIFY_NAME",
        payload: { name }
      });
      if (!res?.ok) {
        log("VERIFY_NAME failed:", res?.error || "unknown");
        return false;
      }
      return Boolean(res.isAwareness);
    } catch (error) {
      log("VERIFY_NAME request error:", error);
      return false;
    }
  }

  async function processCandidate(card, index, state, sentMap) {
    assertNotStopped();

    const cardName = getCandidateNameFromCard(card);
    await updateProgress({ currentCandidate: cardName, status: `Processing ${index + 1}` });

    const profileUrl = getCandidateProfileUrl(card);
    const candidateKey = profileUrl || `candidate:${getCandidateStableId(card)}`;
    if (sentMap[candidateKey]) {
      await closeAnyOpenComposer();
      log("Skipping already messaged candidate:", candidateKey);
      return { skipped: true, sent: false, profileUrl: candidateKey, cardName, reason: "already sent" };
    }

    // New layout: skip candidates that already show "Message sent" in the card
    if (cardAlreadyMessaged(card)) {
      log("Skipping candidate with message already sent (card indicator):", candidateKey);
      sentMap[candidateKey] = Date.now();
      await setSentMap(sentMap);
      return { skipped: true, sent: false, profileUrl: candidateKey, cardName, reason: "message already sent" };
    }

    const isAwarenessCampaign = state.campaignMode === "awareness";
    if (isAwarenessCampaign) {
      const verified = await verifyNameForAwareness(cardName);
      if (!verified) {
        log("Awareness mode: skipping unverified name:", cardName);
        return {
          skipped: true,
          sent: false,
          profileUrl: candidateKey,
          cardName,
          reason: "awareness filter"
        };
      }
      log("Awareness mode: verified name, will message:", cardName);
    }

    card.scrollIntoView({ behavior: "smooth", block: "center" });
    await U.sleep(U.randomInt(1000, 6000));
    const opened = await openCandidateDetails(card);
    if (!opened) {
      throw new Error("Could not safely open applicant details without shortlist action.");
    }
    await safeDelay();

    const panelReady = await waitForRightPanelLoad();
    if (!panelReady) {
      throw new Error("Right panel did not load in time.");
    }

    // Try direct Message button first (new layout with hiring-applicant-contact-message)
    let directMessageBtn = document.querySelector('button[data-view-name="hiring-applicant-contact-message"]');
    if (
      directMessageBtn &&
      (!isVisibleElement(directMessageBtn) ||
        directMessageBtn.closest(".artdeco-dropdown__content-inner, .artdeco-dropdown__content"))
    ) {
      directMessageBtn = null;
    }

    // Fallback: find a standalone "Message" button by text/aria-label in the applicant header area
    if (!directMessageBtn) {
      const headerRoots = getApplicantHeaderRoots();

      for (const root of headerRoots) {
        if (directMessageBtn) break;
        const btns = Array.from(root.querySelectorAll('button, a[role="button"]'));
        directMessageBtn = btns.find((btn) => {
          if (!isVisibleElement(btn)) return false;
          if (btn.closest(".artdeco-dropdown__content-inner, .artdeco-dropdown__content")) return false;
          const text = (btn.textContent || "").trim().toLowerCase();
          const aria = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
          if (text === "message" || aria === "message" || aria.startsWith("message ")) return true;
          if (text === "send message" || aria === "send message") return true;
          return false;
        }) || null;
      }
    }

    // Visible Message button in applicant header only
    if (!directMessageBtn) {
      for (const root of getApplicantHeaderRoots()) {
        const allBtns = Array.from(root.querySelectorAll('button, a[role="button"]'));
        directMessageBtn = allBtns.find((btn) => {
          if (!isVisibleElement(btn)) return false;
          if (btn.closest(".artdeco-dropdown__content-inner, .artdeco-dropdown__content")) return false;
          const text = (btn.textContent || "").trim();
          if (text.toLowerCase() === "message") return true;
          return false;
        }) || null;
        if (directMessageBtn) break;
      }
    }

    let editor, dialog;

    if (directMessageBtn) {
      log("Found direct Message button:", directMessageBtn.textContent?.trim());
      const existingEditors = new Set(getAllComposerEditors());
      const editorWatchPromise = watchForMessageEditor(30000);
      directMessageBtn.click();
      await U.sleep(U.randomInt(1000, 6000));

      editor =
        (await waitForEditorForCurrentApplicant(30000, 250, existingEditors)) ||
        (await waitForLinkedInMessageTextbox(30000, 250)) ||
        (await editorWatchPromise) ||
        (await waitForMessageComposer(30000, 250));
    } else {
      const contactButton = await findContactButton();
      if (!contactButton) {
        const fallback = await handleMissingContactMessage(cardName, candidateKey);
        if (fallback.skipped) return fallback;
        editor = fallback.editor;
      } else {
        contactButton.click();
        await safeDelay();

        const messageOption = await findMessageMenuOption();
        if (!messageOption) {
          const fallback = await handleMissingContactMessage(cardName, candidateKey);
          if (fallback.skipped) return fallback;
          editor = fallback.editor;
        } else {
          const existingEditors = new Set(getAllComposerEditors());
          const editorWatchPromise = watchForMessageEditor(30000);
          log(
            "Clicking message option:",
            messageOption.tagName,
            messageOption.getAttribute("href"),
            (messageOption.textContent || "").trim()
          );
          messageOption.click();
          await U.sleep(U.randomInt(1000, 6000));

          editor =
            (await waitForEditorForCurrentApplicant(30000, 250, existingEditors)) ||
            (await waitForLinkedInMessageTextbox(30000, 250)) ||
            (await editorWatchPromise) ||
            (await waitForMessageComposer(30000, 250));
        }
      }
    }

    if (!editor) {
      const fallback = await handleMissingContactMessage(cardName, candidateKey);
      if (fallback.skipped) return fallback;
      editor = fallback.editor;
    }

    if (!editor) {
      const stateNow = await getState();
      if (!Boolean(stateNow.sendToNotAFit)) {
        log("Skipping — composer unavailable (Not a fit disabled):", cardName);
        return {
          skipped: true,
          sent: false,
          profileUrl: candidateKey,
          cardName,
          reason: "not a fit disabled"
        };
      }
      log("Composer detection debug:", {
        activeBubbleCount: document.querySelectorAll(
          'div.msg-overlay-conversation-bubble[role="dialog"], div.msg-overlay-conversation-bubble--is-active[role="dialog"]'
        ).length,
        msgFormCount: document.querySelectorAll("form.msg-form").length,
        editorCount: getAllComposerEditors().length,
        sendBtnCount: document.querySelectorAll("button.msg-form__send-button, button[type='submit']").length
      });
      throw new Error("Messaging composer failed to open.");
    }

    // Use the editor that appeared after the click (new modal for this applicant), not one that was already open.
    dialog = editor
      ? editor.closest('div[role="dialog"]') ||
        editor.closest("div.msg-overlay-conversation-bubble") ||
        editor.closest("section.msg-overlay-conversation-bubble") ||
        editor.closest("form.msg-form") ||
        document.body
      : null;

    if (hasExistingConversationMessages(dialog, editor)) {
      log("Skipping candidate with existing conversation history:", candidateKey);
      await closeDialog(dialog, editor);
      sentMap[candidateKey] = Date.now();
      await setSentMap(sentMap);
      return {
        skipped: true,
        sent: false,
        profileUrl: candidateKey,
        cardName,
        reason: "existing conversation"
      };
    }

    const dialogName = extractNameFromDialog(dialog);
    const fullName = pickBestCandidateName(cardName, dialogName);
    const parsed = U.parseCandidateName(fullName);
    const firstName = deriveCandidateFirstName(cardName, parsed.name || fullName);
    const jobTitle = getJobTitleFromPanel();

    const chosenTemplate = isAwarenessCampaign
      ? state.awarenessTemplate || state.template
      : state.template;
    log(
      "Campaign mode:",
      isAwarenessCampaign ? "awareness" : "message",
      "for",
      fullName
    );

    const finalMessage = U.fillTemplate(chosenTemplate, {
      name: parsed.name,
      firstName,
      jobTitle
    });

    // Attempt to write the message with retries and delays between attempts.
    // LinkedIn's React/Lexical editor may need time to process DOM events.
    let writeSuccess = false;
    for (let writeAttempt = 0; writeAttempt < 4; writeAttempt++) {
      if (writeAttempt > 0) {
        // Re-focus the editor in case the framework stole focus.
        try { editor.focus(); } catch (_) {}
        await U.sleep(U.randomInt(1000, 6000));
      }
      const ok = U.writeMessageToEditor(editor, finalMessage);
      if (ok) {
        writeSuccess = true;
        break;
      }
      log(`Write attempt ${writeAttempt + 1} did not verify; retrying…`);
      await U.sleep(U.randomInt(1000, 6000));

      // After delay, check again — the framework may have processed events.
      const editorText = (editor.innerText || editor.textContent || "").replace(/\s+/g, " ").trim();
      const expectedText = finalMessage.replace(/\s+/g, " ").trim();
      if (editorText.includes(expectedText) || editorText.includes(expectedText.slice(0, 40))) {
        writeSuccess = true;
        break;
      }
    }
    if (!writeSuccess) {
      log("All write attempts failed. Editor content:",
        (editor.innerText || editor.textContent || "").slice(0, 200));
      throw new Error("Message editor did not accept inserted text after multiple attempts.");
    }
    await U.sleep(U.randomInt(1000, 6000));

    const sendButton = findSendButton(dialog, editor);
    if (!sendButton) {
      throw new Error("Send button not found.");
    }

    let didSend = false;
    if (state.mode === "auto") {
      sendButton.click();
      await U.sleep(U.randomInt(1000, 6000));
      const closed = await closeDialog(dialog, editor);
      if (!closed) {
        log("Composer did not close after send; continuing.");
      }
      didSend = true;
    } else {
      // Test mode: in non-auto mode, close composer without sending.
      const closed = await closeDialog(dialog, editor);
      if (!closed) {
        log("Composer did not close in manual test mode; continuing.");
      }
    }

    if (didSend) {
      sentMap[candidateKey] = Date.now();
      await setSentMap(sentMap);
      return { skipped: false, sent: true, profileUrl: candidateKey, cardName };
    }

    return { skipped: false, sent: false, profileUrl: candidateKey, cardName };
  }

  async function runAutomationLoop() {
    if (runtime.isRunning) return;
    runtime.isRunning = true;
    runtime.stopRequested = false;

    try {
      let state = await getState();
      if (!state.running) {
        runtime.isRunning = false;
        return;
      }

      let sentMap = await getSentMap();
      let sentCount = Number(state.sentCount || 0);
      const maxPerSession = Number(state.maxPerSession || 25);

      await updateProgress({ status: "Running" });

      const cards = (await waitForCandidateCards()) || [];
      if (!cards.length) {
        await updateProgress({
          status: "No applicants found (scroll list and retry)",
          running: false
        });
        await setStatePatch({ running: false });
        return;
      }

      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 3;

      for (let i = 0; i < cards.length; i += 1) {
        assertNotStopped();
        state = await getState();
        if (!state.running) break;
        if (sentCount >= maxPerSession) {
          await updateProgress({ status: `Session cap reached (${maxPerSession})`, running: false });
          await setStatePatch({ running: false });
          break;
        }

        try {
          // Re-query cards each iteration to handle LinkedIn virtualized lists replacing DOM nodes.
          const latestCards = getCandidateCards();
          const currentCard = latestCards[i] || cards[i];
          if (!currentCard) {
            log(`Card ${i} became unavailable, skipping.`);
            continue;
          }
          const result = await processCandidate(currentCard, i, state, sentMap);
          consecutiveFailures = 0; // Reset on success/skip
          if (result.sent) {
            sentCount += 1;
            await updateProgress({ sentCount, currentCandidate: result.cardName, status: "Sent" });
          } else if (result.skipped) {
            let skipStatus = "Skipped duplicate";
            if (result.reason === "existing conversation") {
              skipStatus = "Skipped: already has messages";
            } else if (result.reason === "awareness filter") {
              skipStatus = "Skipped: not in awareness list";
            } else if (result.reason === "not a fit disabled") {
              skipStatus = "Skipped: Not a fit (disabled)";
            }
            await updateProgress({ currentCandidate: result.cardName, status: skipStatus });
          }
        } catch (error) {
          if (error?.code === "STOP_REQUESTED") throw error;
          consecutiveFailures += 1;
          log(`Candidate ${i} processing failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, error?.message);

          // Close any stale composer that may block next candidate
          try { await closeAnyOpenComposer(); } catch (_) {}

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            log("Too many consecutive failures; pausing automation.");
            await updateProgress({
              status: `Paused: ${consecutiveFailures} consecutive failures – ${error?.message || "Unknown error"}`,
              running: false
            });
            await setStatePatch({ running: false });
            break;
          }

          // Single failure: log and continue to next candidate
          await updateProgress({ status: `Skipped (error): ${error?.message || "Unknown"}` });
        }

        await safeDelay();
      }
    } catch (error) {
      if (error?.code === "STOP_REQUESTED") {
        await updateProgress({ status: "Stopped", running: false });
        await setStatePatch({ running: false });
      } else {
        log("Automation loop failed:", error);
        await updateProgress({ status: `Error: ${error?.message || "Unknown"}`, running: false });
        await setStatePatch({ running: false });
      }
    } finally {
      runtime.isRunning = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      if (!message?.type) {
        sendResponse({ ok: false, error: "Missing message type." });
        return;
      }

      if (message.type === "RUN_AUTOMATION") {
        runtime.stopRequested = false;
        runAutomationLoop().catch((error) => log("RUN_AUTOMATION error:", error));
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "STOP_AUTOMATION_NOW") {
        runtime.stopRequested = true;
        await setStatePatch({ running: false, status: "Stopped" });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "CLOSE_MESSAGE_MODAL") {
        await closeAnyOpenComposer();
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: `Unknown content command: ${message.type}` });
    })().catch((error) => {
      log("Message listener error:", error);
      sendResponse({ ok: false, error: error?.message || "Unhandled listener error." });
    });

    return true;
  });
})();
