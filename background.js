// ============================================================
// Tien trinh nen (service worker)
// Moi loi goi toi Google Translate deu di qua day, vi content script
// chay trong ngu canh trang coursera.org nen bi co che CORS chan.
// ============================================================

const TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const MAX_RETRY = 3;
const TIMEOUT_MS = 15000;

async function callTranslateApi(text, sourceLang, targetLang) {
    const params = new URLSearchParams({
        client: "gtx",
        sl: sourceLang,
        tl: targetLang,
        dt: "t",
        q: text
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const res = await fetch(`${TRANSLATE_ENDPOINT}?${params.toString()}`, {
            method: "GET",
            signal: controller.signal
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        const segments = data[0] || [];
        let translated = "";
        for (const seg of segments) {
            if (seg && seg[0]) translated += seg[0];
        }
        return { text: translated, detectedLang: data[2] || sourceLang };
    } finally {
        clearTimeout(timer);
    }
}

async function translateWithRetry(text, sourceLang, targetLang) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
            return await callTranslateApi(text, sourceLang, targetLang);
        } catch (err) {
            lastError = err;
            console.warn(`Lan thu ${attempt} that bai:`, err.message);
            if (attempt < MAX_RETRY) {
                await new Promise(r => setTimeout(r, 600 * attempt));
            }
        }
    }
    throw lastError;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "translateChunk") {
        translateWithRetry(request.text, request.sourceLang || "auto", request.targetLang || "vi")
            .then(result => sendResponse({ ok: true, ...result }))
            .catch(err => sendResponse({ ok: false, error: err.message }));
        return true;
    }
});
