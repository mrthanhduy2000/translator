// ============================================================
// CAU NOI YOUTUBE
//
// Tep nay chay trong ngu canh cua chinh trang YouTube (MAIN world),
// khac voi cac tep con lai chay trong ngu canh rieng cua tien ich.
// Ly do: danh sach phu de nam trong bien noi bo cua trinh phat YouTube,
// chi doc duoc tu ben trong trang.
//
// No khong tu lam gi ca, chi tra loi khi duoc hoi.
// ============================================================

(function () {
    "use strict";

    function layDanhSachPhuDe() {
        let response = null;

        // Cach 1: hoi truc tiep trinh phat (dung ca khi chuyen video khong tai lai trang)
        try {
            const player = document.querySelector("#movie_player");
            if (player && typeof player.getPlayerResponse === "function") {
                response = player.getPlayerResponse();
            }
        } catch (e) { /* thu cach khac */ }

        // Cach 2: bien toan cuc luc trang moi tai
        if (!response && window.ytInitialPlayerResponse) {
            response = window.ytInitialPlayerResponse;
        }

        if (!response) return { error: "Chua doc duoc du lieu trinh phat" };

        const list =
            response.captions &&
            response.captions.playerCaptionsTracklistRenderer &&
            response.captions.playerCaptionsTracklistRenderer.captionTracks;

        if (!list || list.length === 0) {
            return { tracks: [], videoId: (response.videoDetails || {}).videoId || "" };
        }

        return {
            tracks: list.map(t => ({
                baseUrl: t.baseUrl,
                languageCode: t.languageCode || "",
                kind: t.kind || "",                        // "asr" nghia la phu de tu dong
                name: (t.name && (t.name.simpleText ||
                      (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || ""
            })),
            videoId: (response.videoDetails || {}).videoId || "",
            title: (response.videoDetails || {}).title || ""
        };
    }

    window.addEventListener("message", event => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.cstType !== "YEU_CAU_PHU_DE") return;

        let ketQua;
        try {
            ketQua = layDanhSachPhuDe();
        } catch (err) {
            ketQua = { error: String(err && err.message ? err.message : err) };
        }

        window.postMessage({ cstType: "TRA_LOI_PHU_DE", requestId: data.requestId, ...ketQua }, "*");
    });
})();
