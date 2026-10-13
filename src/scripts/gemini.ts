// Gemini Chat – client-side logic.
// Talks directly to Google's official Gemini API with the user's own key:
// POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse

// Module marker: keeps this file's symbols scoped so they don't collide with
// the other page scripts (ai.ts declares many of the same top-level names).
export {};

interface GeminiMessage {
    role: "user" | "model";
    content: string;
}

interface Part {
    text?: string;
}

interface ChunkCandidate {
    content?: { parts?: Part[]; role?: string };
}

interface ChunkResponse {
    candidates?: ChunkCandidate[];
    error?: { message?: string; status?: string };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const API_KEY_STORAGE = "bolt-gemini-key";
const MODEL_STORAGE = "bolt-gemini-model";
const HISTORY_STORAGE = "bolt-gemini-history";
const DEFAULT_MODEL = "gemini-3.8-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ─── State ───────────────────────────────────────────────────────────────────

let history: GeminiMessage[] = [];
let isGenerating = false;
let abortController: AbortController | null = null;

// ─── DOM refs ────────────────────────────────────────────────────────────────

const messagesEl = document.getElementById("gem-messages") as HTMLDivElement;
const messagesContainer = document.getElementById(
    "gem-messages-container"
) as HTMLDivElement;
const chatInput = document.getElementById("gem-input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("gem-send-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("gem-stop-btn") as HTMLButtonElement;
const thinkingIndicator = document.getElementById(
    "gem-thinking"
) as HTMLDivElement;
const welcomeState = document.getElementById("gem-welcome") as HTMLDivElement;
const clearBtn = document.getElementById("gem-clear-btn") as HTMLButtonElement;
const settingsBtn = document.getElementById(
    "gem-settings-btn"
) as HTMLButtonElement;
const settingsPanel = document.getElementById("gem-settings") as HTMLElement;
const settingsClose = document.getElementById(
    "gem-settings-close"
) as HTMLButtonElement;
const apiKeyInput = document.getElementById("gem-api-key") as HTMLInputElement;
const keyRevealBtn = document.getElementById(
    "gem-key-reveal"
) as HTMLButtonElement;
const modelSelect = document.getElementById(
    "gem-model-select"
) as HTMLSelectElement;
const saveBtn = document.getElementById("gem-save-btn") as HTMLButtonElement;
const forgetBtn = document.getElementById(
    "gem-forget-btn"
) as HTMLButtonElement;
const feedbackEl = document.getElementById(
    "gem-settings-feedback"
) as HTMLParagraphElement;
const modelNameEl = document.getElementById(
    "gem-model-name"
) as HTMLSpanElement;
const keyStatusEl = document.getElementById("gem-key-status") as HTMLDivElement;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHTML(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function getApiKey(): string {
    return localStorage.getItem(API_KEY_STORAGE) || "";
}

function getModel(): string {
    return localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL;
}

function saveHistory(): void {
    try {
        localStorage.setItem(HISTORY_STORAGE, JSON.stringify(history));
    } catch {
        /* storage full – history is non-critical */
    }
}

function loadHistory(): void {
    try {
        const raw = localStorage.getItem(HISTORY_STORAGE);
        const parsed = raw ? JSON.parse(raw) : [];
        history = Array.isArray(parsed)
            ? parsed.filter(
                  (m: GeminiMessage) =>
                      (m.role === "user" || m.role === "model") &&
                      typeof m.content === "string"
              )
            : [];
    } catch {
        history = [];
    }
}

function scrollToBottom(smooth = true): void {
    messagesContainer.scrollTo({
        top: messagesContainer.scrollHeight,
        behavior: smooth ? "smooth" : "instant",
    });
}

function nearBottom(): boolean {
    const gap =
        messagesContainer.scrollHeight -
        messagesContainer.scrollTop -
        messagesContainer.clientHeight;
    return gap < 120;
}

function showWelcome(): void {
    if (!welcomeState) return;
    if (!messagesEl.contains(welcomeState)) {
        messagesEl.appendChild(welcomeState);
    }
    welcomeState.style.display = "flex";
}

function hideWelcome(): void {
    if (welcomeState && messagesEl.contains(welcomeState)) {
        welcomeState.style.display = "none";
    }
}

// ─── Settings / key management ───────────────────────────────────────────────

function refreshKeyStatus(): void {
    const hasKey = getApiKey().length > 0;
    const label = keyStatusEl.querySelector(
        ".gem-key-label"
    ) as HTMLSpanElement;
    label.textContent = hasKey ? "Key saved" : "No key";
    keyStatusEl.classList.toggle("has-key", hasKey);
    keyStatusEl.title = hasKey
        ? "API key saved in this browser"
        : "No API key saved — open Settings";
}

function refreshModelBadge(): void {
    modelNameEl.textContent = getModel();
}

function showFeedback(msg: string, ok = true): void {
    feedbackEl.textContent = msg;
    feedbackEl.classList.toggle("error", !ok);
    feedbackEl.classList.add("visible");
    setTimeout(() => feedbackEl.classList.remove("visible"), 3500);
}

function openSettings(): void {
    apiKeyInput.value = getApiKey();
    modelSelect.value = getModel();
    settingsPanel.hidden = false;
    requestAnimationFrame(() => {
        settingsPanel.classList.add("open");
        apiKeyInput.focus();
    });
}

function closeSettings(): void {
    settingsPanel.classList.remove("open");
    setTimeout(() => {
        settingsPanel.hidden = true;
    }, 200);
}

function saveSettings(): void {
    const key = apiKeyInput.value.trim();

    if (key && !key.startsWith("AIza")) {
        showFeedback(
            "That doesn't look like a Gemini API key (they start with \"AIza\"). Saved anyway — double-check it.",
            false
        );
    } else {
        showFeedback(key ? "API key saved to this browser." : "Key cleared.");
    }

    if (key) {
        localStorage.setItem(API_KEY_STORAGE, key);
    } else {
        localStorage.removeItem(API_KEY_STORAGE);
    }

    localStorage.setItem(MODEL_STORAGE, modelSelect.value);
    refreshKeyStatus();
    refreshModelBadge();
    updateSendBtn();
}

function forgetKey(): void {
    localStorage.removeItem(API_KEY_STORAGE);
    apiKeyInput.value = "";
    refreshKeyStatus();
    updateSendBtn();
    showFeedback("API key removed from this browser.");
}

// ─── Message rendering ───────────────────────────────────────────────────────

const USER_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="2"/>
    <path d="M4 20C4 17.1 7.6 15 12 15C16.4 15 20 17.1 20 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

const MODEL_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2L13.8 9.2L21 11L13.8 12.8L12 20L10.2 12.8L3 11L10.2 9.2L12 2Z" fill="currentColor"/>
</svg>`;

function appendBubble(
    role: "user" | "model",
    content: string,
    animate = true
): HTMLDivElement {
    hideWelcome();

    const message = document.createElement("div");
    message.className = `gem-message ${role}`;
    if (!animate) message.style.animation = "none";

    message.innerHTML = `
        <div class="gem-avatar">${role === "user" ? USER_SVG : MODEL_SVG}</div>
        <div class="gem-msg-body">
            <div class="gem-bubble">${escapeHTML(content)}</div>
        </div>
    `;

    messagesEl.appendChild(message);
    return message;
}

function renderHistory(): void {
    messagesEl.querySelectorAll(".gem-message").forEach(el => el.remove());

    if (history.length === 0) {
        showWelcome();
        return;
    }

    history.forEach(msg => appendBubble(msg.role, msg.content, false));
    scrollToBottom(false);
}

// ─── Input handling ──────────────────────────────────────────────────────────

function autoResize(): void {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 180) + "px";
}

function updateSendBtn(): void {
    const hasKey = getApiKey().length > 0;
    sendBtn.disabled = chatInput.value.trim().length === 0 || isGenerating || !hasKey;
    chatInput.placeholder = hasKey
        ? "Message Gemini..."
        : "Add your Gemini API key in Settings to start...";
}

function setGenerating(on: boolean): void {
    isGenerating = on;
    stopBtn.hidden = !on;
    sendBtn.hidden = on;
    updateSendBtn();
}

// ─── Gemini API call ─────────────────────────────────────────────────────────

function buildContents(): { role: string; parts: Part[] }[] {
    // The Gemini API is stateless: the full conversation history is sent
    // every turn, with roles "user" and "model".
    return history.map(m => ({
        role: m.role,
        parts: [{ text: m.content }],
    }));
}

function friendlyError(status: number, apiMessage: string): string {
    if (status === 400 && /API key not valid/i.test(apiMessage)) {
        return "Your API key isn't valid. Open Settings and paste a fresh key from aistudio.google.com/apikey.";
    }
    if (status === 403) {
        return "Access denied (403). This key may not have access to the selected model — try another model in Settings.";
    }
    if (status === 429) {
        return "Rate limit reached (429). The free tier is throttled — wait a moment and try again.";
    }
    if (status >= 500) {
        return "Google's API returned a server error. Try again in a moment.";
    }
    return apiMessage || `Request failed with status ${status}.`;
}

async function streamGenerate(
    apiKey: string,
    model: string,
    onDelta: (text: string) => void
): Promise<void> {
    const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

    abortController = new AbortController();

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            // Official header-based key auth; avoids the key appearing in URLs/logs.
            "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
            contents: buildContents(),
            generationConfig: { temperature: 0.7 },
        }),
        signal: abortController.signal,
    });

    if (!res.ok || !res.body) {
        const errBody: ChunkResponse = await res
            .json()
            .catch(() => ({}) as ChunkResponse);
        throw new Error(friendlyError(res.status, errBody.error?.message || ""));
    }

    // Parse the SSE stream: "data: {...}" lines separated by blank lines.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by blank lines.
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";

        for (const event of events) {
            for (const line of event.split(/\r?\n/)) {
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                if (!payload || payload === "[DONE]") continue;

                let chunk: ChunkResponse;
                try {
                    chunk = JSON.parse(payload);
                } catch {
                    continue; // tolerate malformed keep-alive lines
                }

                if (chunk.error) {
                    throw new Error(chunk.error.message || "Stream error.");
                }

                const parts = chunk.candidates?.[0]?.content?.parts;
                if (parts) {
                    for (const part of parts) {
                        if (part.text) onDelta(part.text);
                    }
                }
            }
        }
    }
}

// ─── Send flow ───────────────────────────────────────────────────────────────

async function sendMessage(): Promise<void> {
    const text = chatInput.value.trim();
    if (!text || isGenerating) return;

    const apiKey = getApiKey();
    if (!apiKey) {
        openSettings();
        showFeedback("Paste your Gemini API key to start chatting.", false);
        return;
    }

    const model = getModel();

    history.push({ role: "user", content: text });
    saveHistory();

    appendBubble("user", text);
    chatInput.value = "";
    autoResize();
    scrollToBottom();

    // Create the streaming assistant bubble.
    hideWelcome();
    const bubbleMessage = document.createElement("div");
    bubbleMessage.className = "gem-message model";
    bubbleMessage.innerHTML = `
        <div class="gem-avatar">${MODEL_SVG}</div>
        <div class="gem-msg-body">
            <div class="gem-bubble streaming"><span class="gem-stream-text"></span><span class="gem-cursor"></span></div>
        </div>
    `;
    messagesEl.appendChild(bubbleMessage);
    const streamEl = bubbleMessage.querySelector(
        ".gem-stream-text"
    ) as HTMLSpanElement;
    const bubbleEl = bubbleMessage.querySelector(".gem-bubble") as HTMLDivElement;

    thinkingIndicator.classList.remove("visible");
    setGenerating(true);

    let reply = "";
    let firstDelta = true;
    let lastPaint = 0;

    try {
        await streamGenerate(apiKey, model, delta => {
            reply += delta;

            // Throttle DOM writes to keep streaming smooth.
            const now = performance.now();
            if (firstDelta || now - lastPaint > 66) {
                streamEl.textContent = reply;
                if (firstDelta || nearBottom()) scrollToBottom(false);
                firstDelta = false;
                lastPaint = now;
            }
        });

        history.push({ role: "model", content: reply });
        saveHistory();

        // Swap the streaming bubble for a settled one.
        bubbleEl.classList.remove("streaming");
        const cursor = bubbleEl.querySelector(".gem-cursor");
        if (cursor) cursor.remove();
        streamEl.textContent = reply;
    } catch (err) {
        const aborted =
            err instanceof DOMException && err.name === "AbortError";

        if (aborted && reply) {
            // Keep the partial answer.
            history.push({ role: "model", content: reply });
            saveHistory();
            bubbleEl.classList.remove("streaming");
            const cursor = bubbleEl.querySelector(".gem-cursor");
            if (cursor) cursor.remove();
            streamEl.textContent = reply + " …(stopped)";
        } else {
            bubbleMessage.remove();
            const message = aborted
                ? "Stopped."
                : err instanceof Error
                  ? err.message
                  : "Something went wrong. Please try again.";
            appendBubble("model", message);
            console.error("Gemini request failed:", err);
        }
    } finally {
        abortController = null;
        setGenerating(false);
        scrollToBottom();
    }
}

function stopGenerating(): void {
    abortController?.abort();
}

// ─── Event listeners ─────────────────────────────────────────────────────────

chatInput.addEventListener("input", () => {
    autoResize();
    updateSendBtn();
});

chatInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

sendBtn.addEventListener("click", sendMessage);
stopBtn.addEventListener("click", stopGenerating);

settingsBtn.addEventListener("click", () => {
    if (settingsPanel.hidden) openSettings();
    else closeSettings();
});
settingsClose.addEventListener("click", closeSettings);
saveBtn.addEventListener("click", saveSettings);
forgetBtn.addEventListener("click", forgetKey);

apiKeyInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") saveSettings();
});

keyRevealBtn.addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
});

modelSelect.addEventListener("change", () => {
    localStorage.setItem(MODEL_STORAGE, modelSelect.value);
    refreshModelBadge();
});

clearBtn.addEventListener("click", () => {
    if (isGenerating) stopGenerating();
    history = [];
    saveHistory();
    renderHistory();
    chatInput.focus();
});

keyStatusEl.addEventListener("click", openSettings);

document.querySelectorAll<HTMLButtonElement>(".gem-chip").forEach(chip => {
    chip.addEventListener("click", () => {
        if (!getApiKey()) {
            openSettings();
            showFeedback("Paste your Gemini API key to start chatting.", false);
            return;
        }
        chatInput.value = chip.dataset.prompt ?? "";
        autoResize();
        updateSendBtn();
        chatInput.focus();
    });
});

// ─── Init ────────────────────────────────────────────────────────────────────

function initGemini(): void {
    loadHistory();
    refreshKeyStatus();
    refreshModelBadge();
    modelSelect.value = getModel();

    if (history.length > 0) {
        renderHistory();
    } else {
        showWelcome();
    }

    autoResize();
    updateSendBtn();

    if (!getApiKey()) {
        openSettings();
    } else {
        chatInput.focus();
    }
}

initGemini();
