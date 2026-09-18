// ============================================================
// LONG TIENG TU DONG (mo phong YouTube auto-dubbing)
//
// YouTube chay 4 buoc: tach giong khoi nhac nen, dich, tao giong AI,
// gan thanh mot track am thanh rieng.
// Trong trinh duyet khong tach duoc giong khoi nhac nen, nen thay bang
// cach giam am luong video goc khi giong doc cat len (ky thuat ducking).
//
// Giong doc lay tu bo doc san co cua he dieu hanh qua Web Speech API.
// ============================================================

const dub = {
    enabled: false,
    voice: null,
    voiceName: "",
    rate: 1.0,
    pitch: 1.0,
    volume: 1.0,
    duckLevel: 0.12,      // am luong video goc khi dang doc
    autoRate: true,       // tu chinh toc do doc cho khop thoi luong dong phu de
    originalVolume: null,
    videoEl: null,
    trackEl: null,
    lastSpokenCue: null,
    speaking: false,
    handlers: null
};

// ---------- Chon giong doc ----------
function loadVoices() {
    return new Promise(resolve => {
        const voices = speechSynthesis.getVoices();
        if (voices.length > 0) return resolve(voices);
        // Tren mot so may danh sach giong nap cham, phai cho su kien
        speechSynthesis.addEventListener("voiceschanged", () => {
            resolve(speechSynthesis.getVoices());
        }, { once: true });
        setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
    });
}

async function pickVietnameseVoice(preferredName) {
    const voices = await loadVoices();
    const vietnamese = voices.filter(v => (v.lang || "").toLowerCase().startsWith("vi"));

    if (preferredName) {
        const exact = voices.find(v => v.name === preferredName);
        if (exact) return exact;
    }
    if (vietnamese.length > 0) {
        // Uu tien giong chat luong cao neu he thong co
        const premium = vietnamese.find(v => /premium|enhanced|natural|neural/i.test(v.name));
        return premium || vietnamese[0];
    }
    return null;
}

// ---------- Uoc luong toc do doc ----------
// Muc tieu: doc xong dung luc dong phu de ket thuc, giong nhu long tieng that.
// Toc do doc tieng Viet o muc binh thuong khoang 15 ky tu moi giay.
function computeRate(text, durationSeconds) {
    if (!dub.autoRate || !durationSeconds || durationSeconds <= 0) return dub.rate;

    const estimatedSeconds = text.length / 15;
    let rate = estimatedSeconds / durationSeconds;

    // Gioi han de giong khong qua cham hoac qua nhanh den muc kho nghe
    rate = Math.max(0.8, Math.min(rate, 2.2));
    return rate * dub.rate;
}

// ---------- Giam am luong video goc ----------
function duckVideo() {
    if (!dub.videoEl) return;
    if (dub.originalVolume === null) dub.originalVolume = dub.videoEl.volume;
    dub.videoEl.volume = dub.duckLevel;
}

function unduckVideo() {
    if (!dub.videoEl || dub.originalVolume === null) return;
    dub.videoEl.volume = dub.originalVolume;
}

// ---------- Doc mot dong phu de ----------
function speakCue(text, durationSeconds) {
    if (!dub.enabled || !text) return;

    // Huy cau dang doc do de bam theo dung nhip video
    speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(text);
    if (dub.voice) utter.voice = dub.voice;
    utter.lang = "vi-VN";
    utter.rate = computeRate(text, durationSeconds);
    utter.pitch = dub.pitch;
    utter.volume = dub.volume;

    utter.onstart = () => {
        dub.speaking = true;
        duckVideo();
    };
    utter.onend = () => {
        dub.speaking = false;
        unduckVideo();
    };
    utter.onerror = (e) => {
        dub.speaking = false;
        unduckVideo();
        if (e.error !== "interrupted" && e.error !== "canceled") {
            console.warn("Loi doc:", e.error);
        }
    };

    speechSynthesis.speak(utter);
}

// ---------- Gan vao trinh phat ----------
function attachDubbing(videoEl, trackEl) {
    detachDubbing();

    dub.videoEl = videoEl;
    dub.trackEl = trackEl;
    dub.originalVolume = videoEl ? videoEl.volume : null;

    const onCueChange = () => {
        if (!dub.enabled) return;
        const active = trackEl.track.activeCues;
        if (!active || active.length === 0) return;

        const cue = active[0];
        if (cue === dub.lastSpokenCue) return;
        dub.lastSpokenCue = cue;

        // Bo phan phu de goc neu dang o che do song ngu, chi doc dong tieng Viet
        const text = (cue.text || "").split("\n")[0]
            .replace(/<[^>]+>/g, "")
            .trim();
        if (!text) return;

        const duration = (cue.endTime || 0) - (cue.startTime || 0);
        speakCue(text, duration);
    };

    const onPause = () => { speechSynthesis.pause(); };
    const onPlay = () => { if (dub.enabled) speechSynthesis.resume(); };
    const onSeek = () => {
        speechSynthesis.cancel();
        dub.lastSpokenCue = null;
        unduckVideo();
    };

    trackEl.track.addEventListener("cuechange", onCueChange);
    if (videoEl) {
        videoEl.addEventListener("pause", onPause);
        videoEl.addEventListener("play", onPlay);
        videoEl.addEventListener("seeking", onSeek);
    }

    dub.handlers = { onCueChange, onPause, onPlay, onSeek };
}

function detachDubbing() {
    if (!dub.handlers) return;
    const { onCueChange, onPause, onPlay, onSeek } = dub.handlers;

    if (dub.trackEl && dub.trackEl.track) {
        dub.trackEl.track.removeEventListener("cuechange", onCueChange);
    }
    if (dub.videoEl) {
        dub.videoEl.removeEventListener("pause", onPause);
        dub.videoEl.removeEventListener("play", onPlay);
        dub.videoEl.removeEventListener("seeking", onSeek);
    }

    speechSynthesis.cancel();
    unduckVideo();
    dub.handlers = null;
    dub.lastSpokenCue = null;
}

// ---------- Nhan cho biet dang nghe giong may ----------
// YouTube gan nhan "auto-dubbed" de nguoi xem biet dang nghe giong AI.
function showDubBadge(container) {
    if (!container || container.querySelector(".cst-dub-badge")) return;
    const badge = document.createElement("div");
    badge.className = "cst-dub-badge";
    badge.textContent = "Lồng tiếng tự động";
    badge.style.cssText = `
        position: absolute; top: 18px; left: 16px;
        padding: 4px 10px; border-radius: 4px;
        background: rgba(0,0,0,0.65); color: #fff;
        font-size: 12px; font-family: sans-serif;
        letter-spacing: 0.2px; z-index: 2147483000;
        pointer-events: none;
    `;
    container.appendChild(badge);
}

function hideDubBadge() {
    const badge = document.querySelector(".cst-dub-badge");
    if (badge) badge.remove();
}

if (typeof window !== "undefined") {
    window.CST_DUB = {
        dub, pickVietnameseVoice, attachDubbing, detachDubbing,
        showDubBadge, hideDubBadge, loadVoices, speakCue
    };
}
