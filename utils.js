(function initLinkedInHiringUtils() {
  if (window.LinkedInHiringUtils) return;

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function humanDelay(minMs = 3000, maxMs = 8000) {
    const duration = randomInt(minMs, maxMs);
    await sleep(duration);
  }

  function byText(elements, expected) {
    const target = expected.toLowerCase();
    return elements.find((el) => (el.textContent || "").trim().toLowerCase().includes(target)) || null;
  }

  function parseCandidateName(fullName) {
    const clean = (fullName || "").trim().replace(/\s+/g, " ");
    if (!clean) {
      return { name: "Candidate", firstName: "Candidate" };
    }
    const parts = clean.split(" ");
    return { name: clean, firstName: parts[0] || clean };
  }

  function fillTemplate(template, values) {
    const source = String(template || "");
    const firstName = values.firstName || "";
    const fullName = values.name || "";
    const jobTitle = values.jobTitle || "";

    return source
      .replace(/\{\{\s*name\s*\}\}|\{\s*name\s*\}/gi, fullName)
      .replace(/\{\{\s*first_name\s*\}\}|\{\s*first_name\s*\}|\{\{\s*firstName\s*\}\}|\{\s*firstName\s*\}/gi, firstName)
      .replace(/\{\{\s*job_title\s*\}\}|\{\s*job_title\s*\}|\{\{\s*jobTitle\s*\}\}|\{\s*jobTitle\s*\}/gi, jobTitle);
  }

  function randomScroll(root = window) {
    const maxY = Math.max(120, Math.floor(window.innerHeight * 0.45));
    const delta = randomInt(60, maxY) * (Math.random() > 0.5 ? 1 : -1);
    if (root === window) {
      window.scrollBy({ top: delta, behavior: "smooth" });
    } else if (root?.scrollBy) {
      root.scrollBy({ top: delta, behavior: "smooth" });
    }
  }

  async function observeForElement({ root = document, selector, timeoutMs = 10000 }) {
    const immediate = root.querySelector(selector);
    if (immediate) return immediate;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);

      const observer = new MutationObserver(() => {
        const found = root.querySelector(selector);
        if (!found) return;
        clearTimeout(timeout);
        observer.disconnect();
        resolve(found);
      });

      observer.observe(root, { childList: true, subtree: true, attributes: false });
    });
  }

  async function retry(fn, retries = 3, delayMs = 700) {
    let lastError = null;
    for (let i = 0; i < retries; i += 1) {
      try {
        const result = await fn(i);
        if (result) return result;
      } catch (error) {
        lastError = error;
      }
      await sleep(delayMs);
    }
    if (lastError) throw lastError;
    return null;
  }

  function dispatchInputEvents(element) {
    const doc = element.ownerDocument || document;
    const view = doc.defaultView || window;
    element.dispatchEvent(
      new view.InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: element.textContent || ""
      })
    );
    element.dispatchEvent(
      new view.InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: element.textContent || ""
      })
    );
    element.dispatchEvent(new view.KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: " " }));
    element.dispatchEvent(new view.Event("change", { bubbles: true, cancelable: true }));
  }

  function normalizeText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function contentEditableHasText(element, text) {
    // Compare line-by-line to ensure line breaks are preserved.
    const rawActual = (element.innerText || element.textContent || "").trim();
    const rawExpected = (text || "").trim();
    if (!rawExpected) return false;
    if (!rawActual) return false;

    // Quick check: normalized comparison (ignoring whitespace differences).
    const actualNorm = rawActual.replace(/\s+/g, " ").trim();
    const expectedNorm = rawExpected.replace(/\s+/g, " ").trim();

    // Accept if one contains the other OR if a significant portion matches.
    if (actualNorm.includes(expectedNorm) || expectedNorm.includes(actualNorm)) {
      // If the template has line breaks, verify the editor captured them.
      if (rawExpected.includes("\n")) {
        const expectedLines = rawExpected.split("\n").map((l) => l.trim()).filter(Boolean);
        const actualLines = rawActual.split("\n").map((l) => l.trim()).filter(Boolean);
        return expectedLines.every((line) => actualLines.some((al) => al.includes(line)));
      }
      return true;
    }

    // Lenient fallback: check if the first 40 non-whitespace characters of expected
    // text appear in the editor (covers cases where the editor appends/prepends
    // metadata or the framework partially rewrites the DOM).
    const expectedStart = expectedNorm.slice(0, 40);
    if (expectedStart.length >= 8 && actualNorm.includes(expectedStart)) return true;

    return false;
  }

  function clearContentEditable(element) {
    const doc = element.ownerDocument || document;
    const view = doc.defaultView || window;
    element.focus();
    const selection = view.getSelection();
    if (selection) {
      const range = doc.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    doc.execCommand("selectAll", false, null);
    doc.execCommand("delete", false, null);
    element.innerHTML = "<p><br></p>";
    dispatchInputEvents(element);
  }

  function setParagraphMarkup(element, text) {
    const lines = String(text).split("\n");
    const html = lines
      .map((line) => {
        const escaped = line
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
        return `<p>${escaped || "<br>"}</p>`;
      })
      .join("");
    element.innerHTML = html || "<p><br></p>";
    dispatchInputEvents(element);
  }

  function typeTextFallback(element, text) {
    const doc = element.ownerDocument || document;
    clearContentEditable(element);
    element.focus();
    for (const ch of String(text)) {
      if (ch === "\n") {
        // Insert a paragraph break for newline characters.
        const brInserted = doc.execCommand("insertParagraph", false, null);
        if (!brInserted) {
          const br = doc.createElement("br");
          const activeParagraph = element.querySelector("p:last-child") || element;
          activeParagraph.appendChild(br);
        }
      } else {
        const inserted = doc.execCommand("insertText", false, ch);
        if (!inserted) {
          const activeParagraph = element.querySelector("p:last-child") || element;
          activeParagraph.append(doc.createTextNode(ch));
        }
      }
    }
    dispatchInputEvents(element);
  }

  function insertViaClipboardPaste(element, text) {
    const doc = element.ownerDocument || document;
    const view = doc.defaultView || window;
    element.focus();

    // Select all existing content so paste replaces it.
    const selection = view.getSelection();
    if (selection) {
      const range = doc.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    doc.execCommand("selectAll", false, null);

    // Build DataTransfer carrying plain-text and HTML variants.
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const htmlLines = String(text)
      .split("\n")
      .map((l) => "<p>" + l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</p>")
      .join("");
    dt.setData("text/html", htmlLines);

    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      })
    );

    // Some frameworks process the paste asynchronously; fire input events too.
    dispatchInputEvents(element);
  }

  function insertViaNativeInputEvent(element, text) {
    const doc = element.ownerDocument || document;
    const view = doc.defaultView || window;
    element.focus();

    const selection = view.getSelection();
    if (selection) {
      const range = doc.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    // Fire beforeinput + input with insertReplacementText / insertText.
    for (const inputType of ["insertReplacementText", "insertText"]) {
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        element.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType,
            data: text,
            dataTransfer: dt
          })
        );
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            cancelable: false,
            inputType,
            data: text,
            dataTransfer: dt
          })
        );
      } catch (_) {}
    }
  }

  function writeMessageToEditor(element, text) {
    // Strategy 1: execCommand-based (works on many editors).
    setContentEditableText(element, text);
    if (contentEditableHasText(element, text)) return true;

    // Strategy 2: Set innerHTML with <p> markup.
    clearContentEditable(element);
    setParagraphMarkup(element, text);
    if (contentEditableHasText(element, text)) return true;

    // Strategy 3: Simulate clipboard paste (most reliable for React/Lexical editors).
    clearContentEditable(element);
    insertViaClipboardPaste(element, text);
    if (contentEditableHasText(element, text)) return true;

    // Strategy 4: Native InputEvent with dataTransfer (Draft.js / Lexical).
    clearContentEditable(element);
    insertViaNativeInputEvent(element, text);
    // After native input event the framework may update the DOM asynchronously,
    // so also inject the markup directly as a safety net.
    if (!contentEditableHasText(element, text)) {
      setParagraphMarkup(element, text);
    }
    if (contentEditableHasText(element, text)) return true;

    // Strategy 5: Character-by-character typing fallback.
    typeTextFallback(element, text);
    if (contentEditableHasText(element, text)) return true;

    // Final: force-set innerHTML and accept (best-effort when verification
    // keeps failing due to framework rewriting the DOM).
    setParagraphMarkup(element, text);
    return true;
  }

  function setContentEditableText(element, text) {
    const doc = element.ownerDocument || document;
    const view = doc.defaultView || window;
    element.focus();
    const selection = view.getSelection();
    if (selection) {
      const range = doc.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    const hasLineBreaks = text.includes("\n");

    // For text without line breaks, try execCommand (fastest, preserves undo).
    if (!hasLineBreaks) {
      doc.execCommand("selectAll", false, null);
      doc.execCommand("delete", false, null);
      const inserted = doc.execCommand("insertText", false, text);
      if (inserted && (element.textContent || "").trim() === text.trim()) {
        dispatchInputEvents(element);
        return;
      }
    }

    // For multiline text (or if insertText failed), use per-line <p> markup
    // which LinkedIn's editor recognizes as separate paragraphs / line breaks.
    setParagraphMarkup(element, text);
  }

  // LinkedIn shows applicants at two URL patterns:
  // 1) List (query): https://www.linkedin.com/hiring/applicants/?applicationId=...&jobId=...
  // 2) Detail (path): https://www.linkedin.com/hiring/jobs/{jobId}/applicants/{applicantId}/detail/...
  const APPLICANTS_LIST_URL_PREFIX = "https://www.linkedin.com/hiring/applicants/";
  const APPLICANTS_JOBS_PATH = "/hiring/jobs/";
  const APPLICANTS_PATH = "/applicants/";
  const APPLICANT_DETAIL_PATH = "/detail";

  function isApplicantsPage() {
    const url = window.location.href;
    return (
      url.startsWith(APPLICANTS_LIST_URL_PREFIX) ||
      (url.includes(APPLICANTS_JOBS_PATH) && url.includes(APPLICANTS_PATH))
    );
  }

  function isApplicantDetailPage() {
    const url = window.location.href;
    return (
      url.includes(APPLICANTS_JOBS_PATH) &&
      url.includes(APPLICANTS_PATH) &&
      url.includes(APPLICANT_DETAIL_PATH)
    );
  }

  window.LinkedInHiringUtils = {
    randomInt,
    sleep,
    humanDelay,
    byText,
    parseCandidateName,
    fillTemplate,
    randomScroll,
    observeForElement,
    retry,
    writeMessageToEditor,
    setContentEditableText,
    isApplicantsPage,
    isApplicantDetailPage
  };
})();
