// ============================================================
// Coursera Subtitle Translator v3
// Sua loi phu de tran man hinh: ban dich duoc phan bo ve tung dong
// theo ty le do dai, thay vi gan ca cau vao moi dong.
// ============================================================

const TARGET_LANG = "vi";
const MAX_CHUNK_CHARS = 1200;      // gioi han ky tu moi lan goi API
const MAX_CUES_PER_GROUP = 3;      // toi da 3 dong phu de gom thanh 1 nhom dich
const MAX_GROUP_CHARS = 240;       // toi da 240 ky tu goc moi nhom
const MAX_CUE_DISPLAY_CHARS = 95;  // canh bao neu 1 dong hien qua dai
const MARKER = " z~~~z ";
const MARKER_REGEX = /[zZ]\s*~+\s*[zZ]/;

const state = {
    active: false,
    dualMode: false,
    perCueMode: false,
    styleOriginal: false,
    glossaryKeep: [],
    glossaryNormalize: [],
    glossaryEnabled: true,
    glossaryMisses: 0,
    glossaryTranslateAs: new Map(),
    reExact: null,
    reLoose: null,
    reRisky: null,
    dubEnabled: false,
    dubVoiceName: "",
    dubDuck: 0.12,
    dubAutoRate: true,
    originalFirst: false,
    originalCueTexts: null,
    activeTrack: null,
    intervals: [],
    observers: [],
    currentUrl: location.href,
    busy: false
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getCurrentSite() {
    const url = location.href;
    if (url.includes("coursera.org")) return "coursera";
    if (url.includes("deeplearning.ai")) return "deeplearning";
    // YouTube do youtube.js lo, vi phu de o do hoat dong theo co che khac han
    if (url.includes("youtube.com")) return "youtube";
    return null;
}

// ---------- Chen CSS gioi han kich thuoc phu de ----------
// Ngan phu de phu kin man hinh khi mot dong lo bi dai
function injectCueStyle() {
    const existing = document.getElementById("cst-cue-style");
    if (existing) existing.remove();

    const style = document.createElement("style");
    style.id = "cst-cue-style";

    // white-space: pre-line la phan sua loi chinh.
    // Gia tri cu la "normal" khien ky tu xuong dong bi coi nhu khoang trang,
    // lam dong tieng Viet va dong tieng Anh dinh lien nhau.
    // "pre-line" giu nguyen cho xuong dong nhung van tu dong ngat khi qua dai.
    let css = `
        video::cue {
            font-size: 1.0em;
            line-height: 1.35;
            background-color: rgba(0, 0, 0, 0.78);
            color: #ffffff;
            white-space: pre-line;
        }
    `;

    // Lam dong goc nho hon va mo hon de tach bach voi dong tieng Viet.
    // Chi ap dung khi nguoi dung bat tuy chon nay, vi mot so phien ban
    // trinh duyet khong ho tro dinh dang rieng cho tung phan trong phu de.
    if (state.styleOriginal) {
        css += `
            video::cue(.cst-orig) {
                font-size: 0.82em;
                color: #cfd8dc;
            }
        `;
    }

    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
}

function setIconState(status) {
    const icon = document.querySelector(".cst-translate-icon");
    if (!icon) return;
    const styles = {
        idle:    { bg: "rgba(0,0,0,0.5)", content: "\u{1F310}", title: "Bat dich phu de sang tieng Viet" },
        loading: { bg: "#E2A11E",         content: "\u{23F3}",  title: "Dang dich, vui long cho..." },
        on:      { bg: "#1E80E2",         content: "\u{1F310}", title: "Dang hien tieng Viet. Bam de tat" },
        error:   { bg: "#D93025",         content: "\u{26A0}",  title: "Dich that bai. Bam de thu lai" }
    };
    const s = styles[status] || styles.idle;
    icon.style.backgroundColor = s.bg;
    icon.innerHTML = s.content;
    icon.title = s.title;
}

// ---------- Bao ve thuat ngu va danh tu rieng ----------
// Y tuong: truoc khi gui di dich, thay moi thuat ngu can giu nguyen
// bang mot ma danh dau tam (vi du ZQ0QZ). May dich khong hieu ma nay
// nen giu nguyen no. Dich xong thi thay ma do tro lai bang thuat ngu goc.
//
// Toc do: thay vi quet van ban mot lan cho MOI thuat ngu (hang tram lan),
// gom tat ca thuat ngu vao MOT bieu thuc duy nhat va chi quet hai lan.

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Muc co chu hoa -> phai so khop dung chu hoa (tranh "Excel" bat nham "excel")
function needsExactCase(term) {
    return /[A-Z]/.test(term);
}

// Bien mot thuat ngu thanh mau nhan dien, co chap nhan dang so nhieu.
// Day la phan sua loi quan trong: truoc day "landing page" khong bat duoc
// "landing pages", "AI agent" khong bat duoc "AI agents".
function termToPattern(term) {
    // Ket thuc bang phu am + y  ->  chap nhan ca "y" va "ies"
    // (case study / case studies, category / categories)
    if (/[bcdfghjklmnpqrstvwxz]y$/i.test(term)) {
        return escapeRegex(term.slice(0, -1)) + "(?:y|ies)";
    }
    // Ket thuc bang chu cai  ->  cho phep them "s" hoac "es"
    // (agent / agents, box / boxes). Neu tu von khong co dang so nhieu
    // thi phan them nay khong khop gi ca, hoan toan vo hai.
    if (/[a-z0-9]$/i.test(term)) {
        return escapeRegex(term) + "(?:e?s)?";
    }
    return escapeRegex(term);
}

// Dung bieu thuc gop tu danh sach thuat ngu, sap xep cum dai truoc
// de "Claude Code" duoc bat truoc "Claude"
function buildMasterRegex(terms, flags) {
    if (terms.length === 0) return null;
    const sorted = [...terms].sort((a, b) => b.length - a.length);
    const parts = sorted.map(termToPattern);
    // Khong cho khop khi ky tu lien ke la chu hoac so
    return new RegExp(`(?<![\\w])(?:${parts.join("|")})(?![\\w])`, flags);
}

// ---------- Thuat ngu phu thuoc ngu canh ----------
// Mot so tu chi la thuat ngu khi doan van dang noi ve linh vuc do.
// "agent" trong bai giang AI la AI agent, nhung trong bai giang bao hiem
// lai la dai ly that. Chi bao ve khi doan van co dau hieu cua linh vuc.
function buildContextualRegex(text) {
    const danhSach = (typeof CST_CONTEXTUAL_TERMS !== "undefined") ? CST_CONTEXTUAL_TERMS : [];
    if (danhSach.length === 0) return null;

    const phuHop = danhSach.filter(muc =>
        muc.context.some(tuKhoa => text.toLowerCase().includes(tuKhoa.toLowerCase()))
    );
    if (phuHop.length === 0) return null;

    const parts = phuHop
        .map(m => m.term)
        .sort((a, b) => b.length - a.length)
        .map(termToPattern);

    try {
        return new RegExp(`(?<![\\w])(?:${parts.join("|")})(?![\\w])`, "gi");
    } catch (e) {
        return null;
    }
}

function rebuildGlossaryRegex() {
    const risky = new Set(
        (typeof CST_RISKY_PROPER !== "undefined" ? CST_RISKY_PROPER : [])
    );

    const exact = [];
    const loose = [];
    const riskyList = [];

    for (const term of state.glossaryKeep) {
        if (!term || term.length < 2) continue;
        if (risky.has(term)) riskyList.push(term);
        else if (needsExactCase(term)) exact.push(term);
        else loose.push(term);
    }

    try {
        state.reExact = buildMasterRegex(exact, "g");
        state.reLoose = buildMasterRegex(loose, "gi");

        // Tang thu ba: ten rieng trung tu tieng Anh thong dung.
        // Chi bao ve khi KHONG dung dau cau, tranh bat nham
        // "Notion of freedom" hay "Excel at your job" o dau cau.
        if (riskyList.length > 0) {
            const sorted = [...riskyList].sort((a, b) => b.length - a.length);
            const parts = sorted.map(escapeRegex);
            state.reRisky = new RegExp(
                `(?<![.!?]["')\\]]?\\s)(?<!^)(?<![\\w])(?:${parts.join("|")})(?![\\w])`,
                "g"
            );
        } else {
            state.reRisky = null;
        }
    } catch (err) {
        console.warn("Khong dung duoc bieu thuc tu dien:", err.message);
        state.reExact = null;
        state.reLoose = null;
        state.reRisky = null;
    }

    console.log(`Tu dien: ${exact.length} muc dung chu hoa, ${loose.length} muc khong phan biet, ${riskyList.length} ten rieng can than trong`);
}

function protectGlossary(text) {
    if (!state.glossaryEnabled) return { text, terms: [] };

    let out = text;

    // Buoc 1: chuan hoa cac bien the ve dang chuan
    for (const [pattern, canonical] of state.glossaryNormalize) {
        try {
            out = out.replace(new RegExp(pattern, "gi"), canonical);
        } catch (e) { /* mau khong hop le thi bo qua */ }
    }

    // Buoc 2: thay thuat ngu bang ma danh dau
    const terms = [];
    const replaceWithToken = (match) => {
        // Neu nguoi dung khai bao dang "tu goc => dang muon hien"
        // thi dien dang muon hien, nguoc lai giu nguyen ban goc
        const custom = state.glossaryTranslateAs.get(match.toLowerCase());
        const id = terms.length;
        terms.push(custom !== undefined ? custom : match);
        return `ZQ${id}QZ`;
    };

    if (state.reExact) {
        state.reExact.lastIndex = 0;
        out = out.replace(state.reExact, replaceWithToken);
    }
    if (state.reLoose) {
        state.reLoose.lastIndex = 0;
        out = out.replace(state.reLoose, replaceWithToken);
    }
    if (state.reRisky) {
        state.reRisky.lastIndex = 0;
        out = out.replace(state.reRisky, replaceWithToken);
    }

    // Tang thu tu: thuat ngu chi co nghia trong dung linh vuc
    const reContext = buildContextualRegex(text);
    if (reContext) {
        out = out.replace(reContext, replaceWithToken);
    }

    return { text: out, terms };
}

function restoreGlossary(text, terms) {
    if (terms.length === 0) return text;

    // Regex khoan dung: may dich doi khi chen khoang trang hoac doi chu hoa thuong
    const restored = text.replace(/Z\s*Q\s*(\d+)\s*Q\s*Z/gi, (match, num) => {
        const idx = parseInt(num, 10);
        return terms[idx] !== undefined ? terms[idx] : match;
    });

    const leftover = restored.match(/Z\s*Q\s*\d+\s*Q\s*Z/gi);
    if (leftover) {
        state.glossaryMisses += leftover.length;
    }

    return restored;
}

function glossaryIntact(translatedText, terms) {
    if (terms.length === 0) return true;
    const found = (translatedText.match(/Z\s*Q\s*\d+\s*Q\s*Z/gi) || []).length;
    return found >= Math.ceil(terms.length * 0.5);
}

// ---------- Tang goi dich thuat ----------
// Goi dich CO bao ve thuat ngu.
// Neu ma danh dau bi may dich lam hong thi tu dong dich lai khong bao ve,
// de it nhat van co ban dich thay vi bao loi.
async function requestTranslation(text) {
    const protectedResult = protectGlossary(text);

    if (protectedResult.terms.length === 0) {
        return rawTranslate(text);
    }

    const res = await rawTranslate(protectedResult.text);

    if (glossaryIntact(res.text, protectedResult.terms)) {
        return { ...res, text: restoreGlossary(res.text, protectedResult.terms) };
    }

    console.warn("Ma danh dau bi hong, dich lai khong bao ve thuat ngu");
    return rawTranslate(text);
}

function rawTranslate(text) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
            { action: "translateChunk", text, sourceLang: "auto", targetLang: TARGET_LANG },
            response => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else if (!response || !response.ok) {
                    reject(new Error(response ? response.error : "Khong co phan hoi"));
                } else {
                    resolve(response);
                }
            }
        );
    });
}

async function translateSentenceGroup(sentences) {
    if (sentences.length === 0) return [];
    if (sentences.length === 1) {
        const res = await requestTranslation(sentences[0]);
        return [res.text.trim()];
    }

    const joined = sentences.join(MARKER);
    try {
        const res = await requestTranslation(joined);
        const parts = res.text
            .split(new RegExp(MARKER_REGEX.source, "g"))
            .map(p => p.trim())
            .filter(p => p.length > 0);
        if (parts.length === sentences.length) return parts;
        console.warn(`So cau khong khop (gui ${sentences.length}, nhan ${parts.length}), chia nho dich lai`);
    } catch (err) {
        console.warn("Loi khi dich nhom cau, chia nho:", err.message);
    }

    const mid = Math.floor(sentences.length / 2);
    const left = await translateSentenceGroup(sentences.slice(0, mid));
    const right = await translateSentenceGroup(sentences.slice(mid));
    return [...left, ...right];
}

async function translateAllSentences(sentences, onProgress) {
    const results = [];
    let batch = [];
    let batchChars = 0;
    let done = 0;

    const flush = async () => {
        if (batch.length === 0) return;
        const translated = await translateSentenceGroup(batch);
        results.push(...translated);
        done += batch.length;
        if (onProgress) onProgress(done, sentences.length);
        batch = [];
        batchChars = 0;
        await sleep(120);
    };

    for (const sentence of sentences) {
        if (batchChars + sentence.length > MAX_CHUNK_CHARS && batch.length > 0) {
            await flush();
        }
        batch.push(sentence);
        batchChars += sentence.length + MARKER.length;
    }
    await flush();
    return results;
}

// ---------- Chon track phu de ----------
function pickBestTrack() {
    const tracks = Array.from(document.getElementsByTagName("track"));
    if (tracks.length === 0) return null;

    const usable = tracks.filter(t => {
        const kind = (t.kind || "").toLowerCase();
        return kind === "" || kind === "subtitles" || kind === "captions";
    });
    const pool = usable.length > 0 ? usable : tracks;

    const viTrack = pool.find(t => (t.srclang || "").toLowerCase().startsWith("vi"));
    if (viTrack) return { track: viTrack, alreadyVietnamese: true };

    const enTrack = pool.find(t => (t.srclang || "").toLowerCase().startsWith("en"));
    const chosen = enTrack || pool[0];
    console.log("Dung track phu de ngon ngu:", chosen.srclang || "(khong ro)");
    return { track: chosen, alreadyVietnamese: false };
}

async function waitForCues(track, maxWaitMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        if (track.cues && track.cues.length > 0) return track.cues;
        await sleep(250);
    }
    return null;
}

// ---------- Gom dong phu de thanh cau ----------
// Co 3 dieu kien dong nhom: gap dau ket cau, du MAX_CUES_PER_GROUP dong,
// hoac vuot MAX_GROUP_CHARS ky tu. Dieu kien 2 va 3 la phan sua loi chinh:
// ban cu khong gioi han nen mot nhom gom qua nhieu dong.
function groupCuesIntoSentences(cues, perCueMode) {
    const groups = [];

    // Che do dich tung dong rieng: moi dong la mot nhom
    if (perCueMode) {
        for (let i = 0; i < cues.length; i++) {
            const text = (cues[i].text || "").replace(/\s+/g, " ").trim();
            if (text.length === 0) continue;
            groups.push({ text, cueIndexes: [i], cueTexts: [text] });
        }
        return groups;
    }

    let buffer = "";
    let cueIndexes = [];
    let cueTexts = [];

    const closeGroup = () => {
        if (buffer.length === 0) return;
        groups.push({ text: buffer, cueIndexes: [...cueIndexes], cueTexts: [...cueTexts] });
        buffer = "";
        cueIndexes = [];
        cueTexts = [];
    };

    for (let i = 0; i < cues.length; i++) {
        const text = (cues[i].text || "").replace(/\s+/g, " ").trim();
        if (text.length === 0) continue;

        buffer = buffer ? `${buffer} ${text}` : text;
        cueIndexes.push(i);
        cueTexts.push(text);

        const endsSentence = /[.!?]["')\]]?$/.test(text);
        const tooManyCues = cueIndexes.length >= MAX_CUES_PER_GROUP;
        const tooLong = buffer.length >= MAX_GROUP_CHARS;

        if (endsSentence || tooManyCues || tooLong) {
            closeGroup();
        }
    }
    closeGroup();

    return groups;
}

// ---------- Phan bo ban dich ve tung dong ----------
// Day la phan sua loi quan trong nhat.
// Ban dich cua ca nhom duoc chia lai cho tung dong theo ty le do dai
// cua dong goc, cat tai ranh gioi giua cac tu de khong dut giua chung.
function distributeTranslation(translatedText, cueTexts) {
    const clean = (translatedText || "").trim();
    if (cueTexts.length <= 1) return [clean];

    const words = clean.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return cueTexts.map(() => "");

    const totalSrcChars = cueTexts.reduce((sum, t) => sum + t.length, 0) || 1;
    const result = [];
    let wordIdx = 0;

    for (let i = 0; i < cueTexts.length; i++) {
        const isLast = i === cueTexts.length - 1;

        if (isLast) {
            result.push(words.slice(wordIdx).join(" "));
            break;
        }

        const remainingSlots = cueTexts.length - i;
        const remainingWords = words.length - wordIdx;

        // Moi dong con lai phai duoc it nhat 1 tu
        const maxTake = Math.max(1, remainingWords - (remainingSlots - 1));
        const share = cueTexts[i].length / totalSrcChars;
        let take = Math.round(words.length * share);
        take = Math.min(Math.max(take, 1), maxTake);

        result.push(words.slice(wordIdx, wordIdx + take).join(" "));
        wordIdx += take;
    }

    return result;
}

// ---------- Ap ban dich len phu de ----------
function applyTranslation(cues, groups, translations) {
    let longestLine = 0;

    for (let i = 0; i < groups.length; i++) {
        const translated = translations[i];
        if (!translated) continue;

        const group = groups[i];
        const parts = distributeTranslation(translated, group.cueTexts);

        for (let j = 0; j < group.cueIndexes.length; j++) {
            const idx = group.cueIndexes[j];
            if (!cues[idx]) continue;

            const piece = (parts[j] || "").trim();
            if (piece.length === 0) continue;
            if (piece.length > longestLine) longestLine = piece.length;

            const original = (state.originalCueTexts.get(idx) || "").replace(/\s+/g, " ").trim();

            if (state.dualMode && original) {
                // Boc dong goc bang the <c.cst-orig> de co the dinh dang rieng.
                // Neu tuy chon dinh dang tat thi de nguyen van ban tho cho an toan.
                const origLine = state.styleOriginal
                    ? `<c.cst-orig>${original}</c>`
                    : original;

                cues[idx].text = state.originalFirst
                    ? `${origLine}\n${piece}`
                    : `${piece}\n${origLine}`;

                // Day cue len mot dong de du cho hien thi 2 dong ma khong bi cat day man hinh
                try {
                    if (cues[idx].snapToLines !== false) {
                        cues[idx].line = -3;
                    }
                } catch (e) { /* mot so trinh duyet khong cho ghi thuoc tinh nay */ }
            } else {
                cues[idx].text = piece;
            }
        }
    }

    if (longestLine > MAX_CUE_DISPLAY_CHARS) {
        console.warn(`Dong phu de dai nhat la ${longestLine} ky tu, co the chiem nhieu dong man hinh`);
    }
    console.log(`Da ap ban dich, dong dai nhat: ${longestLine} ky tu`);
    if (state.glossaryMisses > 0) {
        console.warn(`Co ${state.glossaryMisses} thuat ngu khong khoi phuc duoc dung cach`);
    }
}

function restoreOriginalCues() {
    if (!state.activeTrack || !state.originalCueTexts) return;
    const cues = state.activeTrack.track ? state.activeTrack.track.cues : null;
    if (!cues) return;
    for (const [idx, text] of state.originalCueTexts.entries()) {
        if (!cues[idx]) continue;
        cues[idx].text = text;
        if (state.originalCueLines && state.originalCueLines.has(idx)) {
            try { cues[idx].line = state.originalCueLines.get(idx); } catch (e) { /* bo qua */ }
        }
    }
    console.log("Da khoi phuc phu de goc");
}

// ---------- Luong chinh ----------
async function translateCoursera() {
    const picked = pickBestTrack();
    if (!picked) {
        alert("Khong tim thay phu de nao cho video nay. Hay bat phu de (CC) tren trinh phat roi thu lai.");
        return false;
    }
    if (picked.alreadyVietnamese) {
        alert("Khoa hoc nay da co san phu de tieng Viet chinh thuc, chat luong tot hon dich may. Hay chon Vietnamese trong menu phu de cua trinh phat.");
        return false;
    }

    const trackEl = picked.track;
    trackEl.track.mode = "showing";

    const cues = await waitForCues(trackEl.track);
    if (!cues) {
        alert("Phu de chua nap xong. Hay phat video vai giay roi bam lai nut dich.");
        return false;
    }

    state.originalCueTexts = new Map();
    state.originalCueLines = new Map();
    for (let i = 0; i < cues.length; i++) {
        state.originalCueTexts.set(i, cues[i].text);
        state.originalCueLines.set(i, cues[i].line);
    }
    state.activeTrack = trackEl;

    const groups = groupCuesIntoSentences(cues, state.perCueMode);
    console.log(`Da gom ${cues.length} dong phu de thanh ${groups.length} nhom dich`);

    const translations = await translateAllSentences(
        groups.map(g => g.text),
        (done, total) => {
            const icon = document.querySelector(".cst-translate-icon");
            if (icon) icon.title = `Dang dich ${done}/${total} nhom...`;
        }
    );

    applyTranslation(cues, groups, translations);
    return true;
}

async function enableTranslation() {
    if (state.busy) return;
    state.busy = true;
    state.glossaryMisses = 0;
    injectCueStyle();
    setIconState("loading");

    try {
        const site = getCurrentSite();
        let success = false;
        if (site === "coursera") {
            success = await translateCoursera();
        } else {
            alert("Trang nay chua duoc ho tro.");
        }

        state.active = success;
        setIconState(success ? "on" : "idle");
    } catch (err) {
        console.error("Dich that bai:", err);
        state.active = false;
        setIconState("error");
        alert(`Dich that bai: ${err.message}\nHay kiem tra ket noi mang roi thu lai.`);
    } finally {
        state.busy = false;
    }
}

function disableTranslation() {
    // Tat long tieng truoc vi no doc tu phu de da dich
    if (window.CST_DUB && window.CST_DUB.dub.enabled) {
        window.CST_DUB.dub.enabled = false;
        window.CST_DUB.detachDubbing();
        window.CST_DUB.hideDubBadge();
        setDubIconState(false);
    }
    restoreOriginalCues();
    state.active = false;
    state.originalCueTexts = null;
    state.activeTrack = null;
    setIconState("idle");
}

// ---------- Nut bam tren trinh phat ----------
function createTranslateIcon() {
    const site = getCurrentSite();
    let container = null;

    if (site === "coursera") {
        const selectors = [
            "#video-player-row",
            "div[data-testid='video-player']",
            ".rc-VideoMiniPlayerContainer",
            "div.video-wrapper",
            "video"
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                container = sel === "video" ? el.parentElement : el;
                break;
            }
        }
    } else if (site === "deeplearning") {
        container = document.querySelector("div[data-media-provider]");
    }

    if (!container) return;
    if (container.querySelector(".cst-translate-icon")) return;
    if (getComputedStyle(container).position === "static") {
        container.style.position = "relative";
    }

    const icon = document.createElement("div");
    icon.className = "cst-translate-icon";
    icon.style.cssText = `
        position: absolute; top: 16px; right: 16px;
        width: 40px; height: 40px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 20px; color: #fff; cursor: pointer; opacity: 0.75;
        z-index: 2147483000; transition: opacity 0.2s, background-color 0.2s;
        user-select: none;
    `;
    icon.addEventListener("mouseover", () => { icon.style.opacity = "1"; });
    icon.addEventListener("mouseout", () => { icon.style.opacity = "0.75"; });
    icon.addEventListener("click", event => {
        event.stopPropagation();
        event.preventDefault();
        if (state.active) disableTranslation();
        else enableTranslation();
    });

    container.appendChild(icon);
    setIconState("idle");

    createDubIcon(container);
}

// Nut long tieng rieng, dat ngay duoi nut dich
function createDubIcon(container) {
    if (!container || container.querySelector(".cst-dub-icon")) return;

    const icon = document.createElement("div");
    icon.className = "cst-dub-icon";
    icon.innerHTML = "\u{1F508}";
    icon.title = "Bật lồng tiếng Việt";
    icon.style.cssText = `
        position: absolute; top: 64px; right: 16px;
        width: 40px; height: 40px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 19px; color: #fff; cursor: pointer; opacity: 0.75;
        background-color: rgba(0,0,0,0.5);
        z-index: 2147483000; transition: opacity 0.2s, background-color 0.2s;
        user-select: none;
    `;
    icon.addEventListener("mouseover", () => { icon.style.opacity = "1"; });
    icon.addEventListener("mouseout", () => { icon.style.opacity = "0.75"; });
    icon.addEventListener("click", async event => {
        event.stopPropagation();
        event.preventDefault();
        await toggleDubbing(container);
    });

    container.appendChild(icon);
}

function setDubIconState(on) {
    const icon = document.querySelector(".cst-dub-icon");
    if (!icon) return;
    icon.style.backgroundColor = on ? "#1E8E3E" : "rgba(0,0,0,0.5)";
    icon.innerHTML = on ? "\u{1F509}" : "\u{1F508}";
    icon.title = on ? "Đang lồng tiếng. Bấm để tắt" : "Bật lồng tiếng Việt";
}

// Bat hoac tat long tieng
async function toggleDubbing(container) {
    const api = window.CST_DUB;
    if (!api) {
        alert("Không nạp được phần lồng tiếng.");
        return;
    }

    if (api.dub.enabled) {
        api.dub.enabled = false;
        api.detachDubbing();
        api.hideDubBadge();
        setDubIconState(false);
        return;
    }

    // Long tieng doc tu phu de da dich, nen phai dich truoc
    if (!state.active) {
        const ok = confirm("Cần dịch phụ đề trước khi lồng tiếng. Bắt đầu dịch ngay?");
        if (!ok) return;
        await enableTranslation();
        if (!state.active) return;
    }

    const voice = await api.pickVietnameseVoice(state.dubVoiceName);
    if (!voice) {
        alert(
            "Máy chưa có giọng đọc tiếng Việt.\n\n" +
            "Trên macOS: mở System Settings, vào Accessibility, chọn Spoken Content, " +
            "bấm System Voice rồi Manage Voices và tải giọng tiếng Việt (ví dụ Linh).\n" +
            "Trên Windows: mở Settings, vào Time & language, chọn Speech và thêm giọng tiếng Việt."
        );
        return;
    }

    api.dub.voice = voice;
    api.dub.duckLevel = state.dubDuck;
    api.dub.autoRate = state.dubAutoRate;
    api.dub.enabled = true;

    const videoEl = container.querySelector("video") || document.querySelector("video");
    api.attachDubbing(videoEl, state.activeTrack);
    api.showDubBadge(container);
    setDubIconState(true);

    console.log(`Long tieng bat dau voi giong: ${voice.name} (${voice.lang})`);
}

function watchNavigation() {
    const checkUrl = () => {
        if (location.href !== state.currentUrl) {
            console.log("Da chuyen bai giang, dat lai trang thai");
            state.currentUrl = location.href;
            if (window.CST_DUB && window.CST_DUB.dub.enabled) {
                window.CST_DUB.dub.enabled = false;
                window.CST_DUB.detachDubbing();
                window.CST_DUB.hideDubBadge();
            }
            state.active = false;
            state.originalCueTexts = null;
            state.activeTrack = null;
            setTimeout(createTranslateIcon, 1500);
        }
    };
    const interval = setInterval(checkUrl, 1000);
    state.intervals.push(interval);
    window.addEventListener("popstate", checkUrl);
}


// Nap tu dien: gop cac nhom nganh dang bat voi danh sach nguoi dung tu them
async function loadGlossary() {
    const groups = (typeof CST_GLOSSARY_GROUPS !== "undefined") ? CST_GLOSSARY_GROUPS : {};
    const defaultNorm = (typeof CST_DEFAULT_NORMALIZE !== "undefined") ? CST_DEFAULT_NORMALIZE : [];
    const allGroupKeys = Object.keys(groups);

    try {
        const saved = await chrome.storage.sync.get({
            glossaryEnabled: true,
            enabledGroups: allGroupKeys,
            userKeep: "",
            userNormalize: ""
        });

        state.glossaryEnabled = saved.glossaryEnabled;

        // Gom thuat ngu tu cac nhom nganh dang bat
        const fromGroups = [];
        for (const key of saved.enabledGroups) {
            if (groups[key] && Array.isArray(groups[key].terms)) {
                fromGroups.push(...groups[key].terms);
            }
        }

        // Thuat ngu nguoi dung tu them, moi dong mot tu
        const userKeep = saved.userKeep
            .split("\n")
            .map(s => s.trim())
            .filter(s => s.length > 0 && !s.startsWith("#"));

        // Quy tac dich rieng: "tu goc => dang muon hien"
        // Ve trai duoc bao ve, khi khoi phuc thi dien ve phai
        state.glossaryTranslateAs = new Map();
        const userTerms = [];
        saved.userNormalize
            .split("\n")
            .map(s => s.trim())
            .filter(s => s.includes("=>"))
            .forEach(line => {
                const [from, to] = line.split("=>").map(p => p.trim());
                if (!from || !to) return;
                userTerms.push(from);
                state.glossaryTranslateAs.set(from.toLowerCase(), to);
            });

        state.glossaryKeep = [...new Set([...userKeep, ...userTerms, ...fromGroups])];
        state.glossaryNormalize = defaultNorm;

        rebuildGlossaryRegex();
    } catch (err) {
        console.warn("Khong nap duoc tu dien:", err.message);
        state.glossaryKeep = [];
        state.glossaryNormalize = defaultNorm;
    }
}

async function loadSettings() {
    try {
        const saved = await chrome.storage.sync.get({
            dualMode: false, perCueMode: false, styleOriginal: false, originalFirst: false,
            dubVoiceName: "", dubDuck: 0.12, dubAutoRate: true
        });
        state.dualMode = saved.dualMode;
        state.perCueMode = saved.perCueMode;
        state.styleOriginal = saved.styleOriginal;
        state.originalFirst = saved.originalFirst;
        state.dubVoiceName = saved.dubVoiceName;
        state.dubDuck = saved.dubDuck;
        state.dubAutoRate = saved.dubAutoRate;
        await loadGlossary();
    } catch (err) {
        console.warn("Khong doc duoc tuy chon da luu:", err.message);
    }
}

async function init() {
    await loadSettings();

    // Tren YouTube, youtube.js dam nhiem phan giao dien va dich
    if (getCurrentSite() === "youtube") {
        console.log("Dang o YouTube, phan xu ly do youtube.js dam nhiem");
        return;
    }
    injectCueStyle();
    createTranslateIcon();

    const observer = new MutationObserver(() => {
        if (!document.querySelector(".cst-translate-icon")) createTranslateIcon();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    state.observers.push(observer);

    watchNavigation();
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.method === "translate") {
        state.dualMode = !!request.dualMode;
        state.perCueMode = !!request.perCueMode;
        state.styleOriginal = !!request.styleOriginal;
        state.originalFirst = !!request.originalFirst;
        injectCueStyle();
        if (!state.active) enableTranslation();
        sendResponse({ method: "translate", status: "success" });
        return true;
    }
    if (request.method === "getStatus") {
        sendResponse({ active: state.active, busy: state.busy });
        return true;
    }
});

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
