document.addEventListener("DOMContentLoaded", async () => {
    const keepBox = document.getElementById("userKeep");
    const normBox = document.getElementById("userNormalize");
    const enabledBox = document.getElementById("glossaryEnabled");
    const saveBtn = document.getElementById("saveBtn");
    const clearBtn = document.getElementById("clearBtn");
    const statusEl = document.getElementById("saveStatus");

    const groups = window.CST_GLOSSARY_GROUPS || {};
    const allKeys = Object.keys(groups);

    const saved = await chrome.storage.sync.get({
        userKeep: "", userNormalize: "", glossaryEnabled: true,
        enabledGroups: allKeys
    });

    // Dung danh sach nhom nganh voi so luong thuat ngu cua tung nhom
    const listEl = document.getElementById("groupList");
    for (const key of allKeys) {
        const row = document.createElement("label");
        row.className = "group-row";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.dataset.group = key;
        box.checked = saved.enabledGroups.includes(key);
        const name = document.createElement("span");
        name.textContent = groups[key].label;
        const count = document.createElement("span");
        count.className = "group-count";
        count.textContent = `${groups[key].terms.length} từ`;
        row.append(box, name, count);
        listEl.appendChild(row);

        box.addEventListener("change", saveGroups);
    }

    async function saveGroups() {
        const picked = [...listEl.querySelectorAll("input:checked")].map(b => b.dataset.group);
        await chrome.storage.sync.set({ enabledGroups: picked });
    }
    keepBox.value = saved.userKeep;
    normBox.value = saved.userNormalize;
    enabledBox.checked = saved.glossaryEnabled;

    function flash(msg) {
        statusEl.textContent = msg;
        setTimeout(() => { statusEl.textContent = ""; }, 2500);
    }

    // ---------- Long tieng ----------
    const voiceSel = document.getElementById("dubVoice");
    const duckSlider = document.getElementById("dubDuck");
    const duckValue = document.getElementById("dubDuckValue");
    const autoRateBox = document.getElementById("dubAutoRate");
    const testBtn = document.getElementById("testVoice");

    const dubSaved = await chrome.storage.sync.get({
        dubVoiceName: "", dubDuck: 0.12, dubAutoRate: true
    });

    function fillVoices() {
        const voices = speechSynthesis.getVoices();
        const vi = voices.filter(v => (v.lang || "").toLowerCase().startsWith("vi"));
        voiceSel.innerHTML = "";

        if (vi.length === 0) {
            const opt = document.createElement("option");
            opt.textContent = "Máy chưa có giọng tiếng Việt";
            opt.value = "";
            voiceSel.appendChild(opt);
            return;
        }
        for (const v of vi) {
            const opt = document.createElement("option");
            opt.value = v.name;
            opt.textContent = `${v.name} (${v.lang})`;
            if (v.name === dubSaved.dubVoiceName) opt.selected = true;
            voiceSel.appendChild(opt);
        }
    }
    fillVoices();
    speechSynthesis.addEventListener("voiceschanged", fillVoices);

    duckSlider.value = Math.round(dubSaved.dubDuck * 100);
    duckValue.textContent = `${duckSlider.value}%`;
    autoRateBox.checked = dubSaved.dubAutoRate;

    duckSlider.addEventListener("input", () => {
        duckValue.textContent = `${duckSlider.value}%`;
    });
    duckSlider.addEventListener("change", () => {
        chrome.storage.sync.set({ dubDuck: Number(duckSlider.value) / 100 });
    });
    voiceSel.addEventListener("change", () => {
        chrome.storage.sync.set({ dubVoiceName: voiceSel.value });
    });
    autoRateBox.addEventListener("change", () => {
        chrome.storage.sync.set({ dubAutoRate: autoRateBox.checked });
    });

    testBtn.addEventListener("click", () => {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(
            "Đây là giọng đọc thử. Trong khóa học này chúng ta sẽ tìm hiểu về Claude Code và Google Ads."
        );
        const v = speechSynthesis.getVoices().find(x => x.name === voiceSel.value);
        if (v) u.voice = v;
        u.lang = "vi-VN";
        speechSynthesis.speak(u);
    });

    saveBtn.addEventListener("click", async () => {
        const picked = [...listEl.querySelectorAll("input:checked")].map(b => b.dataset.group);
        await chrome.storage.sync.set({
            userKeep: keepBox.value,
            userNormalize: normBox.value,
            glossaryEnabled: enabledBox.checked,
            enabledGroups: picked,
            dubVoiceName: voiceSel.value,
            dubDuck: Number(duckSlider.value) / 100,
            dubAutoRate: autoRateBox.checked
        });
        flash("Đã lưu. Tải lại trang bài giảng để áp dụng.");
    });

    clearBtn.addEventListener("click", async () => {
        if (!confirm("Xóa toàn bộ thuật ngữ bạn đã thêm? Danh sách mặc định vẫn được giữ.")) return;
        keepBox.value = "";
        normBox.value = "";
        await chrome.storage.sync.set({ userKeep: "", userNormalize: "" });
        flash("Đã xóa.");
    });

    enabledBox.addEventListener("change", async () => {
        await chrome.storage.sync.set({ glossaryEnabled: enabledBox.checked });
    });
});
