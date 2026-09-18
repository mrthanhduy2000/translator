// ============================================================
// DICH PHU DE TREN YOUTUBE
//
// Khac voi Coursera, YouTube khong dung the <track> chuan cua trinh
// duyet ma tu ve phu de bang ma rieng. Vi vay luong xu ly la:
//   1. Hoi cau noi (yt-bridge.js) de lay duong dan ban chep loi
//   2. Tai ban chep loi dang JSON tu may chu YouTube
//   3. Dich bang chinh co che da dung cho Coursera (co bao ve thuat ngu)
//   4. Tu ve phu de tieng Viet de len video, dong bo theo thoi gian chay
// ============================================================

const yt = {
    cues: [],           // [{ start, end, text, vi }]
    active: false,
    busy: false,
    overlay: null,
    rafId: null,
    lastIndex: -1,
    videoEl: null,
    currentVideoId: "",
    requestSeq: 0,
    resizeObserver: null,
    classObserver: null,
    capTionDisplayCu: null,
    daDichXong: false,
    huyDich: false,
    soNhomDaDich: 0,
    tongSoNhom: 0,
    vfcId: null,
    daGanSuKien: false
};

// Bo nho dem: xem lai video cu thi khong phai dich lai tu dau
const YT_CACHE_PREFIX = "ytcache_";
const YT_CACHE_TOI_DA = 15;

async function ytDocCache(videoId) {
    if (!videoId) return null;
    try {
        const key = YT_CACHE_PREFIX + videoId;
        const kq = await chrome.storage.local.get(key);
        return kq[key] || null;
    } catch (e) {
        return null;
    }
}

async function ytGhiCache(videoId, cues) {
    if (!videoId || cues.length === 0) return;
    try {
        const key = YT_CACHE_PREFIX + videoId;
        // Chi luu phan toi thieu de do ton dung luong
        const gon = cues.map(c => [Math.round(c.start * 100) / 100,
                                   Math.round(c.end * 100) / 100,
                                   c.text, c.vi]);
        await chrome.storage.local.set({ [key]: { luc: Date.now(), cues: gon } });
        await ytDonCache();
    } catch (e) {
        console.warn("Khong ghi duoc bo nho dem:", e.message);
    }
}

// Giu lai cac video gan day nhat, xoa bot cai cu
async function ytDonCache() {
    try {
        const tatCa = await chrome.storage.local.get(null);
        const keys = Object.keys(tatCa).filter(k => k.startsWith(YT_CACHE_PREFIX));
        if (keys.length <= YT_CACHE_TOI_DA) return;
        keys.sort((a, b) => (tatCa[a].luc || 0) - (tatCa[b].luc || 0));
        const xoa = keys.slice(0, keys.length - YT_CACHE_TOI_DA);
        await chrome.storage.local.remove(xoa);
    } catch (e) { /* bo qua */ }
}

// ---------- Hoi cau noi de lay danh sach phu de ----------
function ytHoiDanhSachPhuDe(timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const requestId = `cst_${Date.now()}_${yt.requestSeq++}`;

        const onMessage = event => {
            if (event.source !== window) return;
            const d = event.data;
            if (!d || d.cstType !== "TRA_LOI_PHU_DE" || d.requestId !== requestId) return;
            window.removeEventListener("message", onMessage);
            clearTimeout(timer);
            if (d.error) reject(new Error(d.error));
            else resolve(d);
        };

        const timer = setTimeout(() => {
            window.removeEventListener("message", onMessage);
            reject(new Error("Trinh phat khong phan hoi"));
        }, timeoutMs);

        window.addEventListener("message", onMessage);
        window.postMessage({ cstType: "YEU_CAU_PHU_DE", requestId }, "*");
    });
}

// ---------- Chon ban chep loi phu hop ----------
function ytChonTrack(tracks) {
    if (!tracks || tracks.length === 0) return null;

    // Neu video da co phu de tieng Viet do nguoi lam kenh tu them thi khong can dich
    const viThuCong = tracks.find(t => t.languageCode.startsWith("vi") && t.kind !== "asr");
    if (viThuCong) return { track: viThuCong, daCoTiengViet: true };

    // Uu tien: tieng Anh thu cong > tieng Anh tu dong > bat ky thu cong > bat ky
    return {
        track:
            tracks.find(t => t.languageCode.startsWith("en") && t.kind !== "asr") ||
            tracks.find(t => t.languageCode.startsWith("en")) ||
            tracks.find(t => t.kind !== "asr") ||
            tracks[0],
        daCoTiengViet: false
    };
}

// ---------- Tai va doc ban chep loi ----------
async function ytTaiBanChepLoi(baseUrl) {
    // Them fmt=json3 de may chu tra ve dang JSON thay vi XML, de doc hon
    const url = baseUrl.includes("fmt=") ? baseUrl : `${baseUrl}&fmt=json3`;

    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`May chu tra ve ma ${res.status}`);

    const data = await res.json();
    const events = data.events || [];
    const cues = [];

    for (const ev of events) {
        if (!ev.segs) continue;
        const text = ev.segs
            .map(s => s.utf8 || "")
            .join("")
            .replace(/\s+/g, " ")
            .trim();
        if (!text || text === "\n") continue;

        const start = (ev.tStartMs || 0) / 1000;
        const dur = (ev.dDurationMs || 0) / 1000;
        cues.push({ start, end: start + dur, text, vi: "" });
    }

    // Phu de tu dong hay bi chong thoi gian, cat lai cho gon
    for (let i = 0; i < cues.length - 1; i++) {
        if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
    }

    return cues;
}

// ---------- Lop phu de tu ve ----------
function ytTaoLopPhuDe() {
    const player = document.querySelector("#movie_player") ||
                   document.querySelector(".html5-video-player");
    if (!player) return null;

    let overlay = player.querySelector(".cst-yt-overlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.className = "cst-yt-overlay";
    overlay.style.cssText = `
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        max-width: 86%;
        padding: 4px 12px;
        border-radius: 4px;
        background: rgba(8, 8, 8, 0.75);
        color: #fff;
        font-family: "YouTube Noto", Roboto, Arial, sans-serif;
        font-weight: 500;
        line-height: 1.32;
        text-align: center;
        white-space: pre-line;
        text-shadow: 0 1px 2px rgba(0,0,0,0.5);
        pointer-events: none;
        z-index: 60;
        opacity: 0;
        transition: opacity 0.12s ease-out, bottom 0.18s ease-out;
    `;
    player.appendChild(overlay);

    ytCapNhatKichThuoc(player, overlay);

    // Co chu va vi tri phai doi theo kich thuoc trinh phat,
    // nhat la khi vao va ra toan man hinh
    if (window.ResizeObserver && !yt.resizeObserver) {
        yt.resizeObserver = new ResizeObserver(() => ytCapNhatKichThuoc(player, overlay));
        yt.resizeObserver.observe(player);
    }

    // YouTube them lop ytp-autohide khi an thanh dieu khien,
    // luc do phu de nen ha thap xuong cho de nhin
    if (!yt.classObserver) {
        yt.classObserver = new MutationObserver(() => ytCapNhatViTri(player, overlay));
        yt.classObserver.observe(player, { attributes: true, attributeFilter: ["class"] });
    }
    ytCapNhatViTri(player, overlay);

    return overlay;
}

// Co chu ty le theo chieu rong trinh phat, giong cach YouTube lam
function ytCapNhatKichThuoc(player, overlay) {
    if (!player || !overlay) return;
    const rong = player.clientWidth || 640;
    const co = Math.max(15, Math.min(rong * 0.027, 40));
    overlay.style.fontSize = `${co.toFixed(1)}px`;
}

function ytCapNhatViTri(player, overlay) {
    if (!player || !overlay) return;
    const dangAnThanhDieuKhien = player.classList.contains("ytp-autohide");
    overlay.style.bottom = dangAnThanhDieuKhien ? "26px" : "68px";
}

// Tam an phu de goc cua YouTube de hai lop khong chong len nhau
function ytAnPhuDeGoc(an) {
    const khung = document.querySelector(".ytp-caption-window-container");
    if (!khung) return;
    if (an) {
        if (yt.capTionDisplayCu === null) yt.capTionDisplayCu = khung.style.display || "";
        khung.style.display = "none";
    } else if (yt.capTionDisplayCu !== null) {
        khung.style.display = yt.capTionDisplayCu;
        yt.capTionDisplayCu = null;
    }
}

function ytXoaLopPhuDe() {
    const overlay = document.querySelector(".cst-yt-overlay");
    if (overlay) overlay.remove();
    yt.overlay = null;
}

// ---------- Tim dong phu de dang phat ----------
// Dung tim kiem nhi phan vi ban chep loi co the co hang nghin dong
function ytTimCue(timeSeconds) {
    const cues = yt.cues;
    let lo = 0, hi = cues.length - 1, found = -1;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cues[mid].start > timeSeconds) {
            hi = mid - 1;
        } else if (cues[mid].end < timeSeconds) {
            lo = mid + 1;
        } else {
            found = mid;
            break;
        }
    }
    return found;
}

// ---------- Vong lap dong bo ----------
function ytBatDauDongBo() {
    ytDungDongBo();

    const capNhat = () => {
        if (!yt.active) return;

        const video = yt.videoEl;
        const overlay = yt.overlay;
        if (!video || !overlay) return;

        const idx = ytTimCue(video.currentTime);
        if (idx === yt.lastIndex) return;
        yt.lastIndex = idx;

        if (idx === -1) {
            overlay.style.opacity = "0";
            return;
        }

        const cue = yt.cues[idx];
        const vi = cue.vi || "";

        // Doan chua dich xong thi tam an thay vi hien tieng Anh, tranh chop nhay
        if (!vi) {
            overlay.style.opacity = "0";
            return;
        }

        overlay.textContent = state.dualMode
            ? (state.originalFirst ? `${cue.text}\n${vi}` : `${vi}\n${cue.text}`)
            : vi;
        overlay.style.opacity = "1";

        if (window.CST_DUB && window.CST_DUB.dub.enabled) {
            window.CST_DUB.speakCue(vi, cue.end - cue.start);
        }
    };

    // requestVideoFrameCallback bam theo dung khung hinh video nen dong bo
    // sat hon, va khong chay khi video dang tam dung. Neu trinh duyet
    // khong ho tro thi quay ve cach thong thuong.
    if (yt.videoEl && typeof yt.videoEl.requestVideoFrameCallback === "function") {
        const vong = () => {
            if (!yt.active) return;
            capNhat();
            yt.vfcId = yt.videoEl.requestVideoFrameCallback(vong);
        };
        yt.vfcId = yt.videoEl.requestVideoFrameCallback(vong);
    } else {
        const vong = () => {
            if (!yt.active) return;
            capNhat();
            yt.rafId = requestAnimationFrame(vong);
        };
        yt.rafId = requestAnimationFrame(vong);
    }

    // Tua hoac doi toc do phat thi phai tinh lai ngay
    if (yt.videoEl && !yt.daGanSuKien) {
        const datLai = () => { yt.lastIndex = -1; };
        yt.videoEl.addEventListener("seeked", datLai);
        yt.videoEl.addEventListener("ratechange", datLai);
        yt.daGanSuKien = true;
    }
}

function ytDungDongBo() {
    if (yt.rafId) cancelAnimationFrame(yt.rafId);
    if (yt.vfcId && yt.videoEl && typeof yt.videoEl.cancelVideoFrameCallback === "function") {
        yt.videoEl.cancelVideoFrameCallback(yt.vfcId);
    }
    yt.rafId = null;
    yt.vfcId = null;
    yt.lastIndex = -1;
}

// ---------- Luong chinh ----------
// Dich dan theo lo, uu tien doan dang xem truoc.
// Thay vi cho dich het ca video roi moi hien phu de, chi can dich xong
// lo chua thoi diem dang xem la phu de hien ra ngay, phan con lai
// duoc dich tiep trong nen.
const YT_KICH_THUOC_LO = 6;   // so nhom cau moi lo

function ytChiaLo(groups) {
    const los = [];
    for (let i = 0; i < groups.length; i += YT_KICH_THUOC_LO) {
        los.push({ tuNhom: i, denNhom: Math.min(i + YT_KICH_THUOC_LO, groups.length) });
    }
    return los;
}

// Sap xep thu tu dich: bat dau tu lo dang xem, lan ve sau, roi quay lai dau
function ytThuTuDich(los, groups, cues, thoiDiem) {
    let loHienTai = 0;
    for (let i = 0; i < los.length; i++) {
        const nhomDau = groups[los[i].tuNhom];
        const cueDau = cues[nhomDau.cueIndexes[0]];
        if (cueDau && cueDau.start <= thoiDiem) loHienTai = i;
        else break;
    }
    const thuTu = [];
    for (let i = loHienTai; i < los.length; i++) thuTu.push(i);
    for (let i = loHienTai - 1; i >= 0; i--) thuTu.push(i);
    return thuTu;
}

async function ytDichDan(groups, cues) {
    const los = ytChiaLo(groups);
    const video = yt.videoEl;
    const thoiDiem = video ? video.currentTime : 0;
    const thuTu = ytThuTuDich(los, groups, cues, thoiDiem);

    yt.tongSoNhom = groups.length;
    yt.soNhomDaDich = 0;
    yt.daDichXong = false;

    for (const chiSoLo of thuTu) {
        if (yt.huyDich) return;

        const lo = los[chiSoLo];
        const nhomTrongLo = groups.slice(lo.tuNhom, lo.denNhom);

        try {
            const banDich = await translateSentenceGroup(nhomTrongLo.map(g => g.text));

            for (let j = 0; j < nhomTrongLo.length; j++) {
                const nhom = nhomTrongLo[j];
                const vi = banDich[j];
                if (!vi) continue;
                const parts = distributeTranslation(vi, nhom.cueTexts);
                nhom.cueIndexes.forEach((ci, k) => {
                    if (cues[ci]) cues[ci].vi = (parts[k] || "").trim();
                });
            }
        } catch (err) {
            console.warn(`Lo ${chiSoLo} dich that bai:`, err.message);
        }

        yt.soNhomDaDich += nhomTrongLo.length;
        ytCapNhatTienTrinh();

        // Buoc dau tien xong thi cho hien phu de ngay
        if (!yt.active && yt.soNhomDaDich > 0) {
            yt.active = true;
            ytBatDauDongBo();
            ytDatTrangThaiNut("on");
        }

        // Ep lop phu de ve ngay dong hien tai de khong phai cho sang dong sau
        yt.lastIndex = -1;

        await new Promise(r => setTimeout(r, 100));
    }

    yt.daDichXong = true;
    ytCapNhatTienTrinh();
    ytGhiCache(yt.currentVideoId, cues);
}

function ytCapNhatTienTrinh() {
    const icon = document.querySelector(".cst-yt-icon");
    if (!icon) return;
    if (yt.daDichXong) {
        icon.title = "Đang hiện tiếng Việt. Bấm để tắt";
        const badge = icon.querySelector(".cst-yt-progress");
        if (badge) badge.remove();
        return;
    }
    const phanTram = yt.tongSoNhom ? Math.round(yt.soNhomDaDich / yt.tongSoNhom * 100) : 0;
    icon.title = `Đang dịch nền ${phanTram}% (phụ đề đã chạy được rồi)`;

    let badge = icon.querySelector(".cst-yt-progress");
    if (!badge) {
        badge = document.createElement("div");
        badge.className = "cst-yt-progress";
        badge.style.cssText = `
            position: absolute; bottom: -3px; left: 50%;
            transform: translateX(-50%);
            font-size: 9px; background: rgba(0,0,0,0.75);
            padding: 1px 4px; border-radius: 6px; line-height: 1.2;
        `;
        icon.appendChild(badge);
    }
    badge.textContent = `${phanTram}%`;
}

async function ytBatDauDich() {
    if (yt.busy) return false;
    yt.busy = true;
    yt.huyDich = false;
    ytDatTrangThaiNut("loading");

    try {
        const info = await ytHoiDanhSachPhuDe();

        if (!info.tracks || info.tracks.length === 0) {
            alert("Video này không có phụ đề nào để dịch.");
            return false;
        }

        const chon = ytChonTrack(info.tracks);
        if (chon.daCoTiengViet) {
            alert("Video này đã có phụ đề tiếng Việt chính thức. Hãy bật phụ đề trong trình phát YouTube, chất lượng tốt hơn dịch máy.");
            return false;
        }

        yt.currentVideoId = info.videoId || "";
        yt.videoEl = document.querySelector("#movie_player video") ||
                     document.querySelector("video");

        // Xem lai video da dich thi lay ngay tu bo nho dem
        const cache = await ytDocCache(yt.currentVideoId);
        if (cache && cache.cues && cache.cues.length > 0) {
            yt.cues = cache.cues.map(c => ({ start: c[0], end: c[1], text: c[2], vi: c[3] }));
            yt.overlay = ytTaoLopPhuDe();
            ytAnPhuDeGoc(true);
            yt.active = true;
            yt.lastIndex = -1;
            yt.daDichXong = true;
            ytBatDauDongBo();
            if (window.CST_DUB) window.CST_DUB.dub.videoEl = yt.videoEl;
            console.log("Lay ban dich tu bo nho dem, khong can dich lai");
            return true;
        }

        const track = chon.track;
        console.log(`Dung ban chep loi: ${track.languageCode}${track.kind === "asr" ? " (tu dong)" : ""}`);

        const cues = await ytTaiBanChepLoi(track.baseUrl);
        if (cues.length === 0) {
            alert("Tải được phụ đề nhưng không đọc được nội dung.");
            return false;
        }

        yt.cues = cues;
        yt.overlay = ytTaoLopPhuDe();
        ytAnPhuDeGoc(true);

        if (window.CST_DUB) window.CST_DUB.dub.videoEl = yt.videoEl;

        const groups = groupCuesIntoSentences(cues, state.perCueMode);
        console.log(`Da gom ${cues.length} dong thanh ${groups.length} nhom, bat dau dich tu doan dang xem`);

        // Khong cho dich xong het, de no chay tiep trong nen
        ytDichDan(groups, cues);

        // Cho lo dau tien xong de tra ve dung trang thai
        await new Promise(resolve => {
            const cho = setInterval(() => {
                if (yt.active || yt.huyDich || yt.daDichXong) {
                    clearInterval(cho);
                    resolve();
                }
            }, 120);
            setTimeout(() => { clearInterval(cho); resolve(); }, 20000);
        });

        return yt.active;
    } catch (err) {
        console.error("Dich YouTube that bai:", err);
        alert(`Không dịch được: ${err.message}`);
        return false;
    } finally {
        yt.busy = false;
    }
}

function ytTatDich() {
    yt.active = false;
    yt.huyDich = true;
    ytDungDongBo();
    ytAnPhuDeGoc(false);
    ytXoaLopPhuDe();
    yt.cues = [];
    yt.daDichXong = false;

    if (window.CST_DUB && window.CST_DUB.dub.enabled) {
        window.CST_DUB.dub.enabled = false;
        window.CST_DUB.detachDubbing();
        window.CST_DUB.hideDubBadge();
        ytDatTrangThaiNutLongTieng(false);
    }
    ytDatTrangThaiNut("idle");
}

// ---------- Nut bam ----------
function ytDatTrangThaiNut(status) {
    const icon = document.querySelector(".cst-yt-icon");
    if (!icon) return;
    const kieu = {
        idle:    { bg: "rgba(0,0,0,0.55)", noiDung: "\u{1F310}", tip: "Bật phụ đề tiếng Việt" },
        loading: { bg: "#E2A11E",          noiDung: "\u{23F3}",  tip: "Đang dịch, vui lòng chờ..." },
        on:      { bg: "#1E80E2",          noiDung: "\u{1F310}", tip: "Đang hiện tiếng Việt. Bấm để tắt" },
        error:   { bg: "#D93025",          noiDung: "\u{26A0}",  tip: "Dịch thất bại. Bấm để thử lại" }
    }[status] || {};
    if (kieu.bg) icon.style.backgroundColor = kieu.bg;
    if (kieu.noiDung) icon.innerHTML = kieu.noiDung;
    if (kieu.tip) icon.title = kieu.tip;
}

function ytDatTrangThaiNutLongTieng(on) {
    const icon = document.querySelector(".cst-yt-dub-icon");
    if (!icon) return;
    icon.style.backgroundColor = on ? "#1E8E3E" : "rgba(0,0,0,0.55)";
    icon.innerHTML = on ? "\u{1F509}" : "\u{1F508}";
    icon.title = on ? "Đang lồng tiếng. Bấm để tắt" : "Bật lồng tiếng Việt";
}

function ytTaoNut() {
    const player = document.querySelector("#movie_player") ||
                   document.querySelector(".html5-video-player");
    if (!player) return;
    if (player.querySelector(".cst-yt-icon")) return;

    const kieuChung = `
        position: absolute; right: 16px;
        width: 38px; height: 38px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 18px; color: #fff; cursor: pointer; opacity: 0.8;
        background-color: rgba(0,0,0,0.55);
        z-index: 61; transition: opacity 0.2s, background-color 0.2s;
        user-select: none;
    `;
    // position da la absolute nen badge phan tram gan duoc vao ben trong

    // Nut dich
    const icon = document.createElement("div");
    icon.className = "cst-yt-icon";
    icon.style.cssText = kieuChung + "top: 14px;";
    icon.innerHTML = "\u{1F310}";
    icon.title = "Bật phụ đề tiếng Việt";
    icon.addEventListener("mouseover", () => { icon.style.opacity = "1"; });
    icon.addEventListener("mouseout", () => { icon.style.opacity = "0.8"; });
    icon.addEventListener("click", async e => {
        e.stopPropagation();
        e.preventDefault();
        if (yt.active) {
            ytTatDich();
        } else {
            const ok = await ytBatDauDich();
            ytDatTrangThaiNut(ok ? "on" : "idle");
        }
    });

    // Nut long tieng
    const dubIcon = document.createElement("div");
    dubIcon.className = "cst-yt-dub-icon";
    dubIcon.style.cssText = kieuChung + "top: 60px;";
    dubIcon.innerHTML = "\u{1F508}";
    dubIcon.title = "Bật lồng tiếng Việt";
    dubIcon.addEventListener("mouseover", () => { dubIcon.style.opacity = "1"; });
    dubIcon.addEventListener("mouseout", () => { dubIcon.style.opacity = "0.8"; });
    dubIcon.addEventListener("click", async e => {
        e.stopPropagation();
        e.preventDefault();
        await ytChuyenLongTieng(player);
    });

    player.appendChild(icon);
    player.appendChild(dubIcon);
}

async function ytChuyenLongTieng(player) {
    const api = window.CST_DUB;
    if (!api) return;

    if (api.dub.enabled) {
        api.dub.enabled = false;
        api.detachDubbing();
        api.hideDubBadge();
        ytDatTrangThaiNutLongTieng(false);
        return;
    }

    if (!yt.active) {
        if (!confirm("Cần dịch phụ đề trước khi lồng tiếng. Bắt đầu dịch ngay?")) return;
        const ok = await ytBatDauDich();
        ytDatTrangThaiNut(ok ? "on" : "idle");
        if (!ok) return;
    }

    const voice = await api.pickVietnameseVoice(state.dubVoiceName);
    if (!voice) {
        alert(
            "Máy chưa có giọng đọc tiếng Việt.\n\n" +
            "Trên macOS: System Settings, Accessibility, Spoken Content, System Voice, " +
            "Manage Voices rồi tải giọng tiếng Việt (ví dụ Linh)."
        );
        return;
    }

    api.dub.voice = voice;
    api.dub.duckLevel = state.dubDuck;
    api.dub.autoRate = state.dubAutoRate;
    api.dub.videoEl = yt.videoEl;
    api.dub.originalVolume = yt.videoEl ? yt.videoEl.volume : null;
    api.dub.enabled = true;

    // Tren YouTube khong co the <track> nen khong dung cuechange duoc,
    // vong lap dong bo o tren se goi speakCue truc tiep.
    api.showDubBadge(player);
    ytDatTrangThaiNutLongTieng(true);

    // Dung doc va tra lai am luong khi tam dung hoac tua
    if (yt.videoEl) {
        yt.videoEl.addEventListener("seeking", () => {
            speechSynthesis.cancel();
            yt.lastIndex = -1;
        });
        yt.videoEl.addEventListener("pause", () => speechSynthesis.pause());
        yt.videoEl.addEventListener("play", () => {
            if (api.dub.enabled) speechSynthesis.resume();
        });
    }
}

// ---------- Theo doi chuyen video ----------
function ytLayMaVideo() {
    try {
        const u = new URL(location.href);
        return u.searchParams.get("v") || "";
    } catch (e) {
        return "";
    }
}

function ytTheoDoi() {
    let maHienTai = ytLayMaVideo();

    const kiemTra = () => {
        const ma = ytLayMaVideo();

        // Chi so sanh ma video: duong dan doi khi doi vi nhieu ly do khac
        // (mo binh luan, doi moc thoi gian) ma van la cung mot video
        if (ma === maHienTai) return;
        maHienTai = ma;

        if (yt.active || yt.busy) ytTatDich();
        yt.currentVideoId = ma;
        setTimeout(ytTaoNut, 900);
    };

    setInterval(kiemTra, 800);
    window.addEventListener("yt-navigate-finish", kiemTra);
    window.addEventListener("popstate", kiemTra);

    // YouTube dung lai khung trinh phat nhieu lan, phai gan lai nut
    const observer = new MutationObserver(() => {
        if (!document.querySelector(".cst-yt-icon")) ytTaoNut();
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

// ---------- Khoi dong ----------
function ytKhoiDong() {
    if (!location.hostname.includes("youtube.com")) return;
    ytTaoNut();
    ytTheoDoi();
    console.log("Da san sang dich phu de YouTube");
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ytKhoiDong);
} else {
    ytKhoiDong();
}
