(() => {
  const U = window.LinkedInHiringUtils;
  if (!U?.isSupportedHiringPage()) return;

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

  function getPageKind() {
    return U.getHiringPageKind();
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
    const profileAnchor = card.querySelector?.('a[href*="/in/"]') || (card.matches?.('a[href*="/in/"]') ? card : null);
    if (profileAnchor?.href && profileAnchor.href.includes("/in/")) return profileAnchor.href;

    const href = card.getAttribute?.("href") || card.href || card.querySelector?.("a[href]")?.href || "";
    if (href) {
      try {
        const url = new URL(href, window.location.origin);
        const candidateId = url.searchParams.get("candidateId");
        if (candidateId) return `${url.origin}/hiring/candidates/?candidateId=${candidateId}`;
        const applicationId = url.searchParams.get("applicationId");
        if (applicationId) return `${url.origin}/hiring/applicants/?applicationId=${applicationId}`;
        if (url.pathname.includes("/applicants/") && url.pathname.includes("/detail")) {
          return url.origin + url.pathname;
        }
      } catch (_) {}
    }

    // Classic layout: applicant detail link (strip query params for stable key)
    const applicantLink =
      card.querySelector?.('a[href*="/applicants/"][href*="/detail/"]') ||
      card.querySelector?.('a[href*="/hiring/jobs/"]');
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
    // Candidate search / applicants hub: name before "·" on the card link text
    if (card.matches?.("a[href*='candidateId='], a[href*='applicationId=']")) {
      const raw = (card.innerText || card.textContent || "").replace(/\s+/g, " ").trim();
      const name = raw.split("·")[0].trim();
      if (name) return name;
    }

    const hubTitle = card.querySelector?.("p");
    if (hubTitle?.textContent?.trim() && getPageKind() !== "classic-applicants") {
      const maybe = hubTitle.textContent.trim().split("·")[0].trim();
      if (maybe && maybe.split(" ").length >= 1 && maybe.length < 80) {
        // Prefer lockup title below when present
      }
    }

    // Classic / older layout: name from entity lockup title
    const lockupTitle =
      card.querySelector?.('.artdeco-entity-lockup__title.hiring-people-card__title') ||
      card.querySelector?.('.artdeco-entity-lockup__title');
    if (lockupTitle?.textContent?.trim()) return lockupTitle.textContent.trim();

    const ariaNameEl = Array.from(card.querySelectorAll?.("[aria-label]") || []).find((el) => {
      const value = (el.getAttribute("aria-label") || "").trim();
      if (!value) return false;
      if (value.toLowerCase().includes("view full profile")) return false;
      return value.split(" ").length >= 2;
    });
    if (ariaNameEl) {
      const raw = ariaNameEl.getAttribute("aria-label") || "";
      return raw.replace(/,\s*verified profile/i, "").trim();
    }

    const strongText = card.querySelector?.("strong");
    if (strongText?.textContent?.trim()) return strongText.textContent.trim();
    const spans = Array.from(card.querySelectorAll?.("span") || []);
    const likely = spans.find((s) => (s.textContent || "").trim().split(" ").length >= 2);
    if (likely?.textContent?.trim()) return likely.textContent.trim();
    const paragraph = card.querySelector?.("p");
    if (paragraph?.textContent?.trim()) {
      return paragraph.textContent.trim().split("·")[0].trim();
    }
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

  function collectUniqueIdLinks(paramName) {
    const seen = new Set();
    const cards = [];
    const anchors = Array.from(document.querySelectorAll(`a[href*="${paramName}="]`));
    for (const anchor of anchors) {
      if (!(anchor instanceof HTMLElement) || !isVisibleElement(anchor)) continue;
      let id = "";
      try {
        id = new URL(anchor.href, window.location.origin).searchParams.get(paramName) || "";
      } catch (_) {
        continue;
      }
      if (!id || seen.has(id)) continue;

      const text = (anchor.innerText || anchor.textContent || "").replace(/\s+/g, " ").trim();
      // Skip nav / utility links only. Do NOT filter on "qualifications" —
      // Candidate Search cards often include "Meets most qualifications".
      if (!text || /^(add a coworker|candidate search)$/i.test(text)) continue;
      if (/add a coworker/i.test(text) && text.split(" ").length <= 4) continue;
      if (text.split(" ").length < 2) continue;

      // Prefer links that look like a person card (name · ...)
      const namePart = text.split("·")[0].trim();
      if (!namePart || namePart.length < 2 || namePart.length > 80) continue;

      seen.add(id);
      cards.push(anchor);
    }
    return cards;
  }

  function getCandidateSearchCards() {
    return collectUniqueIdLinks("candidateId");
  }

  function getApplicantsHubCards() {
    const byComponent = Array.from(
      document.querySelectorAll('a[componentkey^="paginatedApplicantCard-"]')
    ).filter((a) => isVisibleElement(a));
    if (byComponent.length) {
      const seen = new Set();
      const cards = [];
      for (const anchor of byComponent) {
        let id = "";
        try {
          id = new URL(anchor.href, window.location.origin).searchParams.get("applicationId") || "";
        } catch (_) {}
        if (!id) id = (anchor.getAttribute("componentkey") || "").replace("paginatedApplicantCard-", "");
        if (!id || seen.has(id)) continue;
        const text = (anchor.innerText || "").replace(/\s+/g, " ").trim();
        if (!text || text.split(" ").length < 2) continue;
        if (/add a coworker/i.test(text)) continue;
        // Real applicant cards usually look like "Name · …"
        const namePart = text.split("·")[0].trim();
        if (!namePart || namePart.length < 2 || namePart.length > 80) continue;
        seen.add(id);
        cards.push(anchor);
      }
      if (cards.length) return cards;
    }
    return collectUniqueIdLinks("applicationId");
  }

  function getCandidateCards() {
    const kind = getPageKind();
    if (kind === "candidates") return getCandidateSearchCards();
    if (kind === "applicants-hub") return getApplicantsHubCards();

    // Classic layout: hiring applicants list items
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
    // Candidate search / applicants hub: the card itself is the selector link
    if (
      card.matches?.('a[href*="candidateId="], a[href*="applicationId="], a[componentkey^="paginatedApplicantCard-"]')
    ) {
      card.click();
      await U.sleep(U.randomInt(1000, 6000));
      return true;
    }

    // Classic layout: click the hiring applicant link directly
    const hiringApplicantLink = card.querySelector('a[href*="/applicants/"][href*="/detail/"]');
    if (hiringApplicantLink) {
      hiringApplicantLink.click();
      await U.sleep(U.randomInt(1000, 6000));
      return true;
    }

    const hubLink =
      card.querySelector?.('a[href*="applicationId="]') ||
      card.querySelector?.('a[href*="candidateId="]');
    if (hubLink) {
      hubLink.click();
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
        'a[href*="candidateId="], a[href*="applicationId="], a[componentkey^="paginatedApplicantCard-"], [data-testid="applicantListCollectionRef"] [role="button"][tabindex="0"], [role="listitem"], [role="option"], li[data-test-applicant-card], [data-test-applicant-name], li.hiring-applicants__list-item',
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
    // Wait for contact/message actions or details section after card click.
    const panel = await U.observeForElement({
      root: document,
      selector:
        'a[aria-label^="Send a message"], a[href*="/messaging/compose"], button[data-view-name="hiring-applicant-contact"], button[data-view-name="hiring-applicant-contact-message"], button[aria-label*="Contact"], button[aria-label="Message"], [data-test-applicant-details], [role="region"], .hiring-applicant-header',
      timeoutMs: 12000
    });
    if (panel) return true;

    // Fallback: visible Message / Contact controls (classic + applicants hub)
    const allBtns = Array.from(document.querySelectorAll("button, a"));
    const msgBtn = allBtns.find((btn) => {
      if (!isVisibleElement(btn)) return false;
      const text = (btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const aria = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
      return (
        text === "message" ||
        text === "contact" ||
        aria.startsWith("send a message") ||
        aria === "message" ||
        aria === "contact"
      );
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

      // Applicants hub (new UI): Contact is a plain visible button in the detail actions
      const globalContact = Array.from(document.querySelectorAll("button")).find((btn) => {
        if (!isVisibleElement(btn)) return false;
        return (btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "contact";
      });
      return globalContact || null;
    }, 3, 1000);
  }

  function findDirectSendMessageAction() {
    const byAria = Array.from(document.querySelectorAll("a, button")).find((el) => {
      if (!isVisibleElement(el)) return false;
      const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
      return aria.startsWith("send a message");
    });
    if (byAria) return byAria;

    const composeLinks = Array.from(
      document.querySelectorAll('a[href*="/messaging/compose/"]')
    ).filter((el) => {
      if (!isVisibleElement(el)) return false;
      if (el.closest('[role="menu"], .artdeco-dropdown__content, .artdeco-dropdown__content-inner')) {
        return false;
      }
      const href = el.getAttribute("href") || "";
      const text = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (text !== "message" && !href.includes("profileUrn") && !href.includes("recipient=")) {
        return false;
      }
      return true;
    });
    if (composeLinks.length) return composeLinks[0];

    return null;
  }

  /**
   * Hiring Message links (Candidates + Applicants hub) often include params that
   * open LinkedIn's AI/generated compose UI. When generation fails there is no
   * writable editor ("problem generating the message"). Keep only the fields
   * needed for a normal msgOverlay composer.
   */
  function toPlainComposeHref(href) {
    if (!href || !href.includes("/messaging/compose")) return href;
    try {
      const url = new URL(href, location.origin);
      const keep = new Set(["profileUrn", "recipient", "subject", "interop"]);
      for (const key of [...url.searchParams.keys()]) {
        if (!keep.has(key) || key.toLowerCase().startsWith("gai")) {
          url.searchParams.delete(key);
        }
      }
      // Re-add keep keys that were wrongly deleted if gai* matched — keep set already excludes gai
      url.searchParams.set("interop", "msgOverlay");
      return `${url.pathname}${url.search}`;
    } catch (_) {
      return href;
    }
  }

  function composeHrefNeedsPlainRewrite(href) {
    if (!href || !href.includes("/messaging/compose")) return false;
    const lower = href.toLowerCase();
    return (
      lower.includes("gaiintenttype=") ||
      lower.includes("gaicontenttype=") ||
      lower.includes("gaicontexturn=") ||
      lower.includes("screencontext=") ||
      lower.includes("hiring_outreach") ||
      lower.includes("jobpostingurn=") ||
      lower.includes("jobapplicationurn=") ||
      lower.includes("jobvalidationtoken=") ||
      lower.includes("contextentityurn=") ||
      lower.includes("workflowid=")
    );
  }

  function prepareMessageActionForManualCompose(el) {
    if (!el || el.tagName !== "A") return el;
    const href = el.getAttribute("href") || "";
    if (!composeHrefNeedsPlainRewrite(href) && !href.toLowerCase().includes("gai")) return el;
    const plain = toPlainComposeHref(href);
    if (plain && plain !== href) {
      el.setAttribute("href", plain);
      log("Rewrote hiring Message link to plain msgOverlay compose");
    }
    return el;
  }

  function isAiComposeBlockedUi() {
    const nodes = Array.from(
      document.querySelectorAll('[role="alert"], p, div, span, h2, h3')
    ).slice(0, 400);
    return nodes.some((el) => {
      if (!isVisibleElement(el)) return false;
      const text = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!text || text.length > 180) return false;
      return (
        text.includes("problem generating the message") ||
        text === "rate this ai-generated content" ||
        text.includes("rate this ai-generated")
      );
    });
  }

  function dismissAiComposeNotices() {
    const closes = Array.from(document.querySelectorAll('button[aria-label="Close"]')).filter(
      isVisibleElement
    );
    for (const btn of closes.slice(0, 3)) {
      try {
        btn.click();
      } catch (_) {}
    }
  }

  function openPlainComposeOverlay(fromHref) {
    const plain = toPlainComposeHref(fromHref);
    if (!plain || !plain.includes("/messaging/compose")) return false;
    const link = document.createElement("a");
    link.href = plain;
    link.setAttribute("href", plain);
    // Keep relative so LinkedIn SPA opens msgOverlay instead of full navigation.
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    log("Opened plain compose overlay:", plain);
    return true;
  }

  async function clickMessageActionAndWaitForEditor(actionEl) {
    const originalHref = actionEl?.getAttribute?.("href") || "";
    prepareMessageActionForManualCompose(actionEl);

    // Close leftover composers so we never attach to the previous candidate.
    try {
      await closeOpenComposerIfNeeded(3500);
    } catch (_) {}

    const existingEditors = new Set(getAllComposerEditors());
    actionEl.click();
    await U.sleep(U.randomInt(1000, 6000));

    // Cap total wait so LinkedIn rate-limits don't stack into multi-minute hangs.
    let editor =
      (await waitForEditorForCurrentApplicant(10000, 250, existingEditors)) ||
      (await waitForLinkedInMessageTextbox(8000, 250)) ||
      (await waitForMessageComposer(5000, 250));

    // If LinkedIn reused a pre-existing editor node, drop it and open plain compose.
    if (editor && existingEditors.has(editor)) {
      log("Ignoring stale composer from previous candidate");
      editor = null;
    }

    if (!editor && (composeHrefNeedsPlainRewrite(originalHref) || isAiComposeBlockedUi() || existingEditors.size > 0)) {
      log("Composer missing or stale — retrying plain compose");
      dismissAiComposeNotices();
      await U.sleep(U.randomInt(400, 900));
      try {
        await closeAnyOpenComposer(2500);
      } catch (_) {}
      const retryExisting = new Set(getAllComposerEditors());
      const retryHref = actionEl?.getAttribute?.("href") || originalHref;
      if (openPlainComposeOverlay(retryHref || originalHref)) {
        await U.sleep(U.randomInt(1000, 6000));
        editor =
          (await waitForEditorForCurrentApplicant(12000, 250, retryExisting)) ||
          (await waitForLinkedInMessageTextbox(8000, 250)) ||
          (await waitForMessageComposer(5000, 250));
        if (editor && retryExisting.has(editor)) editor = null;
      }
    }

    return editor;
  }

  function fillSubjectIfPresent(dialog, editor, subjectText) {
    if (!subjectText) return;
    const root =
      dialog ||
      editor?.closest("form.msg-form") ||
      editor?.closest(".msg-form") ||
      editor?.closest('div[role="dialog"]') ||
      document;
    const subject =
      root.querySelector('input.msg-form__subject, input[name="subject"]') ||
      root.querySelector('input[aria-label*="Subject" i], input[placeholder*="Subject" i]') ||
      Array.from(root.querySelectorAll("input")).find((el) => {
        if (!isVisibleElement(el)) return false;
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        const ph = (el.getAttribute("placeholder") || "").toLowerCase();
        return aria.includes("subject") || ph.includes("subject");
      });
    if (!subject || !isVisibleElement(subject)) return;
    if ((subject.value || "").trim()) return;

    try {
      subject.focus();
      subject.value = subjectText.slice(0, 80);
      subject.dispatchEvent(new Event("input", { bubbles: true }));
      subject.dispatchEvent(new Event("change", { bubbles: true }));
      log("Filled message subject");
    } catch (_) {}
  }

  function findMessageOptionInMenu(menu) {
    if (!menu) return null;
    const menuItems = Array.from(
      menu.querySelectorAll(
        "button, [role='menuitem'], a, div[role='button'], div.artdeco-dropdown__item, li, span[role='menuitem']"
      )
    );
    const exact = menuItems.find((item) => {
      if (!isVisibleElement(item)) return false;
      const text = (item.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return text === "message";
    });
    if (exact) return exact;

    const messageItem = menuItems.find((item) => {
      if (!isVisibleElement(item)) return false;
      const text = (item.textContent || "").trim().toLowerCase();
      if (!(text === "message" || text.includes("message"))) return false;
      if (text.includes("share")) return false;
      if (text.includes("mark as contacted")) return false;
      return true;
    });
    return messageItem || null;
  }

  async function findMessageMenuOption() {
    return U.retry(async () => {
      const docs = getSearchDocuments();
      for (const doc of docs) {
        try {
          const menus = [
            ...querySelectorAllIncludingShadow(doc.body || doc.documentElement, 'div[role="menu"]'),
            ...querySelectorAllIncludingShadow(doc.body || doc.documentElement, '[role="listbox"]'),
            ...Array.from(doc.querySelectorAll('div[role="menu"], [role="menu"], [role="listbox"]'))
          ];
          for (const menu of menus) {
            const messageItem = findMessageOptionInMenu(menu);
            if (messageItem && isVisibleElement(messageItem)) return messageItem;
          }
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
          const candidates = querySelectorAllIncludingShadow(
            root,
            "button, a, div[role='menuitem'], div[role='button'], [role='menuitem']"
          );
          const visible = candidates.filter((el) => isVisibleElement(el));
          const messageEl = visible.find((el) => {
            const text = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            if (text !== "message" && !text.startsWith("message ")) return false;
            if (text.includes("share")) return false;
            // Applicants hub Message links include subject= — that is valid, do not skip.
            return true;
          });
          if (messageEl) return messageEl;
        } catch (_) {}
      }
      return null;
    }, 8, 700);
  }

  function getApplicantHeaderRoots() {
    return [
      document.querySelector(".hiring-applicant-header"),
      document.querySelector("[data-test-applicant-details]"),
      document.querySelector('[data-view-name="hiring-applicant-details"]'),
      document.querySelector('[data-testid="applicant-detail"]'),
      document.querySelector('[data-testid="applicantDetails"]'),
      // Applicants hub: prefer the right-side detail column when present
      document.querySelector('aside'),
      document.querySelector('[role="complementary"]'),
      document.querySelector("main section"),
      document.querySelector("main")
    ].filter(Boolean);
  }

  function findApplicantsHubContactButton() {
    const roots = getApplicantHeaderRoots();
    for (const root of roots) {
      const buttons = Array.from(root.querySelectorAll("button")).filter(isVisibleElement);
      const contact = buttons.find((btn) => {
        const text = (btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        const aria = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
        return text === "contact" || aria === "contact" || aria.startsWith("contact ");
      });
      if (contact) return contact;
    }

    return (
      Array.from(document.querySelectorAll("button")).find((btn) => {
        if (!isVisibleElement(btn)) return false;
        const text = (btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return text === "contact";
      }) || null
    );
  }

  async function openApplicantsHubComposer() {
    // Hub: Contact → menu → Message (compose link with jobApplicationUrn/subject).
    const contactButton = findApplicantsHubContactButton() || (await findContactButton());
    if (!contactButton) {
      const direct = findDirectSendMessageAction();
      if (direct && isVisibleElement(direct)) {
        log("Applicants hub: using direct Message action");
        return clickMessageActionAndWaitForEditor(direct);
      }
      throw new Error("Applicants hub Contact button not found.");
    }

    log("Applicants hub: clicking Contact");
    contactButton.click();
    await safeDelay();

    const messageOption = await findMessageMenuOption();
    if (!messageOption) {
      throw new Error("Applicants hub Message option not found in Contact menu.");
    }

    log(
      "Applicants hub: clicking Message in menu:",
      messageOption.tagName,
      messageOption.getAttribute("href"),
      (messageOption.textContent || "").trim()
    );
    return clickMessageActionAndWaitForEditor(messageOption);
  }

  async function openMessageViaMoreMenu() {
    const moreButton = await findMoreButtonInHeader();
    if (!moreButton) {
      throw new Error("More button not found for Not a fit applicant.");
    }

    moreButton.click();
    await safeDelay();

    const messageOption = await findMessageInMoreDropdown();
    if (!messageOption) {
      throw new Error("Message option in More menu was not found.");
    }
    log("Clicking Message in More menu:", (messageOption.textContent || "").trim());
    return clickMessageActionAndWaitForEditor(messageOption);
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
    const existing = existingEditorSet || new Set();
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const activeEditor = getEditorInActiveBubble();
      if (activeEditor && !existing.has(activeEditor)) return activeEditor;

      const allEditors = getAllComposerEditors();
      const newEditor = allEditors.find((ed) => !existing.has(ed));
      if (newEditor) return newEditor;

      // Only reuse an already-open editor when we had none tracked (first open).
      // Never fall back to a stale composer from the previous candidate.
      if (allEditors.length > 0 && existing.size === 0) {
        return pickBestComposerEditor(allEditors) || allEditors[allEditors.length - 1];
      }

      await U.sleep(pollMs);
    }
    const allEditors = getAllComposerEditors();
    const newEditor = allEditors.find((ed) => !existing.has(ed));
    if (newEditor) return newEditor;
    if (existing.size === 0 && allEditors.length) {
      return pickBestComposerEditor(allEditors) || allEditors[allEditors.length - 1];
    }
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

  function watchForMessageEditor(timeoutMs = 30000, existingEditorSet = null) {
    const existing = existingEditorSet || new Set();
    // Do not resolve immediately with a composer that was already open —
    // that is usually the previous candidate's bubble still on screen.
    if (existing.size === 0) {
      const immediate = findAnyMessageEditorNow();
      if (immediate) return Promise.resolve(immediate);
    }

    return (async () => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const editors = getAllComposerEditors();
        const fresh = editors.find((ed) => !existing.has(ed));
        if (fresh) return fresh;
        if (existing.size === 0 && editors.length) {
          return pickBestComposerEditor(editors) || editors[editors.length - 1];
        }
        await U.sleep(200);
      }
      return null;
    })();
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
      "div.msg-overlay-conversation-bubble",
      "div[role='dialog'][class*='msg-overlay']"
    ];
    let hidAny = false;
    for (const doc of docs) {
      try {
        const root = doc.body || doc.documentElement || doc;
        for (const sel of overlaySelectors) {
          const nodes = querySelectorAllIncludingShadow(root, sel);
          for (const el of nodes) {
            if (!el || el.getAttribute("data-lhm-hidden") === "1") continue;
            if (!(el.getBoundingClientRect?.().width > 0)) continue;
            el.setAttribute("data-lhm-hidden", "1");
            el.style.setProperty("display", "none", "important");
            hidAny = true;
          }
        }
      } catch (_) {}
    }
    return hidAny;
  }

  function listOpenMessageOverlayRoots() {
    const roots = [];
    const seen = new Set();
    const docs = getSearchDocuments();
    const selectors = [
      "div.msg-overlay-conversation-bubble--is-active[role='dialog']",
      "div.msg-overlay-conversation-bubble[role='dialog']",
      "section.msg-overlay-conversation-bubble",
      "div.msg-overlay-conversation-bubble",
      "form.msg-form"
    ];
    for (const doc of docs) {
      try {
        const root = doc.body || doc.documentElement || doc;
        for (const sel of selectors) {
          for (const el of querySelectorAllIncludingShadow(root, sel)) {
            if (!el || seen.has(el)) continue;
            if (!isVisibleElement(el) && el.getAttribute("data-lhm-hidden") !== "1") continue;
            // Prefer conversation bubbles; skip bare forms nested inside an already-listed bubble.
            if (el.matches?.("form.msg-form") && el.closest(".msg-overlay-conversation-bubble")) continue;
            seen.add(el);
            roots.push(el);
          }
        }
      } catch (_) {}
    }
    return roots;
  }

  function findOverlayCloseButton(overlayRoot) {
    if (!overlayRoot) return null;
    const headerControls =
      querySelectorIncludingShadow(overlayRoot, ".msg-overlay-bubble-header__controls") ||
      overlayRoot.querySelector?.(".msg-overlay-bubble-header__controls");
    let closeBtn = getCloseButtonFromHeader(headerControls);
    if (closeBtn) return closeBtn;

    const buttons = Array.from(overlayRoot.querySelectorAll?.("button") || []).filter(isVisibleElement);
    const ranked = buttons
      .map((btn) => {
        const aria = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
        const text = (btn.textContent || "").trim().toLowerCase();
        const iconType =
          btn.querySelector("svg[data-test-icon]")?.getAttribute("data-test-icon")?.toLowerCase() || "";
        let score = 0;
        if (aria.includes("close your conversation") || aria.includes("close your draft")) score += 30;
        if (aria.includes("close conversation") || text.includes("close your conversation")) score += 25;
        if (iconType.includes("close-small") || iconType.includes("close")) score += 15;
        if (aria === "close" || text === "close") score += 8;
        if (aria.includes("minimize") || text.includes("minimize")) score -= 20;
        if (btn.closest(".msg-overlay-bubble-header__controls, .msg-overlay-bubble-header")) score += 5;
        return { btn, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return ranked[0]?.btn || null;
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

  async function closeAnyOpenComposer(timeoutMs = 5000) {
    const started = Date.now();
    let closedAll = true;

    while (Date.now() - started < timeoutMs) {
      const overlays = listOpenMessageOverlayRoots().filter(
        (el) => el.getAttribute("data-lhm-hidden") !== "1" && isVisibleElement(el)
      );
      const editor = findAnyMessageEditorNow();
      if (!overlays.length && !editor) return true;

      for (const overlay of overlays) {
        const closeBtn = findOverlayCloseButton(overlay);
        if (closeBtn) {
          forceClick(closeBtn);
          clickDiscardDraftIfPrompted();
        } else {
          dispatchEscapeKey(overlay);
          clickDiscardDraftIfPrompted();
        }
      }

      if (editor && !overlays.length) {
        const dialog =
          editor.closest("div.msg-overlay-conversation-bubble") ||
          editor.closest("section.msg-overlay-conversation-bubble") ||
          editor.closest('div[role="dialog"]') ||
          editor.closest("form.msg-form");
        const closeBtn = findOverlayCloseButton(dialog) || findComposerCloseButton(dialog);
        if (closeBtn) {
          forceClick(closeBtn);
          clickDiscardDraftIfPrompted();
        } else {
          dispatchEscapeKey(document.documentElement);
          clickDiscardDraftIfPrompted();
        }
      }

      await U.sleep(350);
      const stillOpen =
        listOpenMessageOverlayRoots().some(
          (el) => el.getAttribute("data-lhm-hidden") !== "1" && isVisibleElement(el)
        ) || Boolean(findAnyMessageEditorNow());
      if (!stillOpen) return true;
      closedAll = false;
    }

    // Force-hide leftovers so the next candidate is not blocked.
    hideOverlayLastResort();
    const leftover = findAnyMessageEditorNow();
    if (leftover) {
      const bubble =
        leftover.closest("div.msg-overlay-conversation-bubble") ||
        leftover.closest("section.msg-overlay-conversation-bubble") ||
        leftover.closest('div[role="dialog"]');
      if (bubble) {
        bubble.setAttribute("data-lhm-hidden", "1");
        bubble.style.setProperty("display", "none", "important");
      }
    }
    return !findAnyMessageEditorNow() && closedAll
      ? true
      : !listOpenMessageOverlayRoots().some(
          (el) => el.getAttribute("data-lhm-hidden") !== "1" && isVisibleElement(el)
        );
  }

  function hasOpenComposer() {
    if (findAnyMessageEditorNow()) return true;
    return listOpenMessageOverlayRoots().some(
      (el) => el.getAttribute("data-lhm-hidden") !== "1" && isVisibleElement(el)
    );
  }

  /** Close only when a composer is actually open (avoids extra delay on clean pages). */
  async function closeOpenComposerIfNeeded(timeoutMs = 3500) {
    if (!hasOpenComposer()) return true;
    return closeAnyOpenComposer(timeoutMs);
  }

  /**
   * Let LinkedIn settle, then close once. Force-close only if still open.
   * Keeps Candidate Search multi-message reliability without closing too abruptly.
   */
  async function settleThenCloseComposer(dialog, editor) {
    await U.sleep(U.randomInt(1000, 2000));
    const closed = await closeDialog(dialog, editor, 5000);
    if (closed && !hasOpenComposer()) return true;
    log("Composer still open after settle+close; force-closing overlays.");
    await closeAnyOpenComposer(3500);
    return !hasOpenComposer();
  }

  async function closeDialog(dialog, editor, timeoutMs = 6000) {
    let container = resolveComposerContainer(dialog, editor);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      container = resolveComposerContainer(dialog, editor) || container;
      if (!isComposerStillOpen(container, dialog, editor)) return true;

      let closeBtn =
        findOverlayCloseButton(container) ||
        findComposerCloseButton(container) ||
        findComposerCloseButtonInAllDocuments();

      if (!closeBtn) {
        const ariaClose = findCloseButtonByAriaInAllDocuments();
        const aria = (ariaClose?.getAttribute("aria-label") || "").toLowerCase();
        // Avoid generic page "Close" (candidate details); only conversation/draft closes.
        if (
          ariaClose &&
          (aria.includes("conversation") || aria.includes("draft") || aria.includes("message"))
        ) {
          closeBtn = ariaClose;
        }
      }

      if (closeBtn) {
        forceClick(closeBtn);
        clickDiscardDraftIfPrompted();
      } else {
        dispatchEscapeKey(container?.ownerDocument?.documentElement || document.documentElement);
        if (container) dispatchEscapeKey(container);
        clickDiscardDraftIfPrompted();
      }

      await U.sleep(400);
      if (!isComposerStillOpen(container, dialog, editor)) return true;
    }

    if (isComposerStillOpen(container, dialog, editor)) {
      hideOverlayLastResort();
    }
    return !isComposerStillOpen(container, dialog, editor);
  }

  /**
   * Awareness API allows CORS (*). Prefer page-context fetch so we are not
   * blocked when the MV3 service worker stalls (common with Cloudflare).
   */
  async function postVerifyName(url, name, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
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
          ? `VERIFY_NAME timed out after ${timeoutMs}ms`
          : error?.message || "VERIFY_NAME request failed."
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @returns {Promise<{ verified: boolean, apiError: string|null }>}
   */
  async function verifyNameForAwareness(applicantName) {
    const name = String(applicantName || "").trim();
    if (!name || name === "Candidate") {
      return { verified: false, apiError: null };
    }

    let apiUrl = null;
    try {
      const meta = await chrome.runtime.sendMessage({ type: "GET_VERIFY_NAME_URL" });
      if (meta?.ok && meta.url) apiUrl = meta.url;
    } catch (_) {}

    if (apiUrl) {
      let direct = await postVerifyName(apiUrl, name, 12000);
      if (!direct.ok) {
        await U.sleep(400);
        direct = await postVerifyName(apiUrl, name, 12000);
      }
      if (direct.ok) {
        return { verified: Boolean(direct.isAwareness), apiError: null };
      }
      log("VERIFY_NAME page fetch failed, falling back to background:", direct.error);
    }

    try {
      const res = await chrome.runtime.sendMessage({
        type: "VERIFY_NAME",
        payload: { name }
      });
      if (!res?.ok) {
        const apiError = res?.error || "unknown";
        log("VERIFY_NAME failed:", apiError);
        return { verified: false, apiError };
      }
      return { verified: Boolean(res.isAwareness), apiError: null };
    } catch (error) {
      const apiError = error?.message || "VERIFY_NAME request error";
      log("VERIFY_NAME request error:", apiError);
      return { verified: false, apiError };
    }
  }

  async function processCandidate(card, index, state, sentMap) {
    assertNotStopped();

    // Clear a leftover messaging overlay only if one is actually open.
    try {
      await closeOpenComposerIfNeeded(3500);
    } catch (_) {}

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
      const { verified, apiError } = await verifyNameForAwareness(cardName);
      if (apiError) {
        // Don't treat API/network failures as "not in awareness list".
        throw new Error(`Awareness API error: ${apiError}`);
      }
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

    // Try direct Message action first (candidate search + classic message buttons)
    let directMessageBtn =
      findDirectSendMessageAction() ||
      document.querySelector('button[data-view-name="hiring-applicant-contact-message"]');
    if (
      directMessageBtn &&
      (!isVisibleElement(directMessageBtn) ||
        directMessageBtn.closest(".artdeco-dropdown__content-inner, .artdeco-dropdown__content, [role='menu']"))
    ) {
      directMessageBtn = null;
    }

    // Fallback: find a standalone "Message" button by text/aria-label in the applicant header area
    if (!directMessageBtn) {
      const headerRoots = getApplicantHeaderRoots();

      for (const root of headerRoots) {
        if (directMessageBtn) break;
        const btns = Array.from(root.querySelectorAll('button, a, a[role="button"]'));
        directMessageBtn = btns.find((btn) => {
          if (!isVisibleElement(btn)) return false;
          if (btn.closest(".artdeco-dropdown__content-inner, .artdeco-dropdown__content, [role='menu']")) {
            return false;
          }
          const text = (btn.textContent || "").trim().toLowerCase();
          const aria = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
          if (text === "message" || aria === "message" || aria.startsWith("message ")) return true;
          if (text === "send message" || aria === "send message") return true;
          if (aria.startsWith("send a message")) return true;
          return false;
        }) || null;
      }
    }

    // Visible Message control in header roots
    if (!directMessageBtn) {
      for (const root of getApplicantHeaderRoots()) {
        const allBtns = Array.from(root.querySelectorAll('button, a, a[role="button"]'));
        directMessageBtn = allBtns.find((btn) => {
          if (!isVisibleElement(btn)) return false;
          if (btn.closest(".artdeco-dropdown__content-inner, .artdeco-dropdown__content, [role='menu']")) {
            return false;
          }
          const text = (btn.textContent || "").trim();
          if (text.toLowerCase() === "message") return true;
          return false;
        }) || null;
        if (directMessageBtn) break;
      }
    }

    let editor, dialog;
    const pageKind = getPageKind();

    if (pageKind === "applicants-hub") {
      try {
        editor = await openApplicantsHubComposer();
      } catch (hubError) {
        log("Applicants hub Contact→Message failed, trying shared fallbacks:", hubError?.message);
        editor = null;
      }
    }

    if (!editor && directMessageBtn) {
      log("Found direct Message button:", directMessageBtn.textContent?.trim());
      editor = await clickMessageActionAndWaitForEditor(directMessageBtn);
    } else if (!editor) {
      const contactButton =
        (pageKind === "applicants-hub" ? findApplicantsHubContactButton() : null) ||
        (await findContactButton());
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
          log(
            "Clicking message option:",
            messageOption.tagName,
            messageOption.getAttribute("href"),
            (messageOption.textContent || "").trim()
          );
          editor = await clickMessageActionAndWaitForEditor(messageOption);
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

    // Hiring/InMail composers sometimes require a subject before Send enables.
    const subjectGuess =
      (jobTitle && `Opportunity: ${jobTitle}`) ||
      finalMessage.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 80) ||
      "Hello";
    fillSubjectIfPresent(dialog, editor, subjectGuess);

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
      await settleThenCloseComposer(dialog, editor);
      didSend = true;
    } else {
      // Manual mode: fill for review, settle briefly, then close for the next person.
      await settleThenCloseComposer(dialog, editor);
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

      const pageKind = getPageKind();
      const wantedSource = state.pageSource === "candidates" ? "candidates" : "applicants";
      const actualSource = pageKind === "candidates" ? "candidates" : "applicants";
      if (wantedSource !== actualSource) {
        const msg =
          wantedSource === "candidates"
            ? "Open Candidate Search tab (or switch popup Source to Applicants)"
            : "Open Applicants tab (or switch popup Source to Candidate Search)";
        await updateProgress({ status: msg, running: false });
        await setStatePatch({ running: false });
        return;
      }

      log("Starting automation on page kind:", pageKind, "campaign:", state.campaignMode);

      let sentMap = await getSentMap();
      let sentCount = Number(state.sentCount || 0);
      const maxPerSession = Number(state.maxPerSession || 25);

      await updateProgress({
        status: `Running (${
          pageKind === "candidates"
            ? "Candidate Search"
            : pageKind === "applicants-hub"
              ? "Applicants hub"
              : "Applicants"
        })`
      });

      const cards = (await waitForCandidateCards()) || [];
      if (!cards.length) {
        await updateProgress({
          status:
            pageKind === "candidates"
              ? "No candidates found (scroll the list and retry)"
              : "No applicants found (scroll list and retry)",
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

      if (message.type === "PING") {
        sendResponse({ ok: true, pageKind: getPageKind() });
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
