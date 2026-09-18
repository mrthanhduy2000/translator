document.addEventListener("DOMContentLoaded", async () => {
    const translateBtn = document.getElementById("translateBtn");
    const dualModeBox = document.getElementById("dualMode");
    const perCueBox = document.getElementById("perCueMode");
    const styleOrigBox = document.getElementById("styleOriginal");
    const origFirstBox = document.getElementById("originalFirst");
    const statusEl = document.getElementById("status");

    const saved = await chrome.storage.sync.get({
        dualMode: false, perCueMode: false, styleOriginal: false, originalFirst: false
    });
    dualModeBox.checked = saved.dualMode;
    perCueBox.checked = saved.perCueMode;
    styleOrigBox.checked = saved.styleOriginal;
    origFirstBox.checked = saved.originalFirst;

    // Hai tuy chon phu chi co y nghia khi che do song ngu dang bat
    function syncSubOptions() {
        const on = dualModeBox.checked;
        [styleOrigBox, origFirstBox].forEach(box => {
            box.disabled = !on;
            box.parentElement.style.opacity = on ? "1" : "0.45";
        });
    }
    syncSubOptions();

    dualModeBox.addEventListener("change", () => {
        chrome.storage.sync.set({ dualMode: dualModeBox.checked });
        syncSubOptions();
    });
    styleOrigBox.addEventListener("change", () => {
        chrome.storage.sync.set({ styleOriginal: styleOrigBox.checked });
    });
    origFirstBox.addEventListener("change", () => {
        chrome.storage.sync.set({ originalFirst: origFirstBox.checked });
    });
    perCueBox.addEventListener("change", () => {
        chrome.storage.sync.set({ perCueMode: perCueBox.checked });
    });

    function showStatus(message, isError) {
        statusEl.textContent = message;
        statusEl.style.color = isError ? "#D93025" : "#1E8E3E";
    }

    document.getElementById("openOptions").addEventListener("click", () => {
        chrome.runtime.openOptionsPage();
    });

    translateBtn.addEventListener("click", async () => {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !/coursera\.org|deeplearning\.ai|youtube\.com/.test(tab.url || "")) {
                showStatus("Hãy mở một bài giảng trên Coursera hoặc một video YouTube trước.", true);
                return;
            }
            const payload = {
                method: "translate",
                dualMode: dualModeBox.checked,
                perCueMode: perCueBox.checked,
                styleOriginal: styleOrigBox.checked,
                originalFirst: origFirstBox.checked
            };
            try {
                await chrome.tabs.sendMessage(tab.id, payload);
            } catch (err) {
                await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["glossary.js", "dubbing.js", "content.js", "youtube.js"] });
                await chrome.tabs.sendMessage(tab.id, payload);
            }
            showStatus("Đang xử lý. Xem tiến trình ở nút tròn trên video.", false);
        } catch (error) {
            console.error("Loi:", error);
            showStatus(`Không thực hiện được: ${error.message}`, true);
        }
    });
});
