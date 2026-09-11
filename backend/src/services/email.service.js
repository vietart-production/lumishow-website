const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "LumiShow <booking@lumishow.vn>";

// Cho phép nhiều người nhận (Resend nhận mảng ở field "to"); .env override vẫn
// dùng 1 chuỗi, phân tách bằng dấu phẩy.
function parseEmailList(envValue, fallback) {
    return (envValue || fallback)
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
}

// Mail liên hệ (form trang Liên hệ)
const CONTACT_TO_EMAILS = parseEmailList(
    process.env.CONTACT_TO_EMAIL,
    "lumishow.va@gmail.com,vietartclaude@gmail.com"
);

// Mail nội bộ báo có khách đặt vé thành công — nhận riêng ở đây, KHÔNG dùng
// chung danh sách với mail liên hệ hay mail cảnh báo lỗi kỹ thuật bên dưới.
const ORDER_NOTIFY_EMAILS = parseEmailList(
    process.env.ORDER_NOTIFY_EMAIL,
    "lumishow.va@gmail.com,haophamcircus@gmail.com,vietartclaude@gmail.com"
);

// Mail cảnh báo LỖI KỸ THUẬT (vd. xung đột ghế) — cố tình KHÔNG dùng chung
// ORDER_NOTIFY_EMAILS: đây là cảnh báo cho người xử lý kỹ thuật/vận hành hệ
// thống, không phải cho đội kinh doanh nhận thông báo đơn vé bình thường.
const TECH_ALERT_EMAILS = parseEmailList(
    process.env.TECH_ALERT_EMAIL,
    "vietartclaude@gmail.com"
);

// Render tự inject biến này với URL public thật của service — dùng làm gốc
// cho ảnh QR (xem ticket.routes.js). Fallback localhost để test ở máy local.
const PUBLIC_API_BASE =
    process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

const VENUE_NAME = "Rạp Xiếc Trung Ương";
const VENUE_ADDRESS = "67-69 Trần Nhân Tông, Hai Bà Trưng, Hà Nội";
const SUPPORT_HOTLINE = "0869 512 246 (Ms. Chi)";

// Ảnh thật đã có sẵn trên site — dùng thẳng URL công khai, không nhúng base64
// (các file này nặng vài trăm KB tới hơn 1MB, nhúng vào mail sẽ làm mail quá khổ).
const ASSET_BASE = "https://lumishow.vn/image";
const HERO_IMG = `${ASSET_BASE}/SonThanThuyQuai.jpg`;
const LOGO_IMG = `${ASSET_BASE}/logo-lumishow.png`;
// Ảnh chữ "Sơn Thần Thủy Quái" dựng sẵn (font + màu gradient như trên web) —
// dùng ảnh thay vì text thật vì @font-face/gradient-text không tương thích
// đều tay giữa các mail client (đã thử font thật, vẫn lỗi dấu tiếng Việt trên
// một số client PC như Outlook desktop). Ảnh loại bỏ hẳn rủi ro font phía client.
const TITLE_IMG = `${ASSET_BASE}/textSTTQMail.png`;

// Font thật của web (Oswald/Montserrat) lấy trực tiếp từ Google Fonts (fonts.gstatic.com) —
// khác với font FTV Raghlick tự host trên Firebase Hosting hồi trước, CDN này trả sẵn
// Access-Control-Allow-Origin:* nên @font-face load cross-origin (mọi mail client, luôn
// khác origin lumishow.vn) không bị chặn CORS. Mỗi family 2 khối theo unicode-range
// (vietnamese/latin) — cả 2 khối cùng trỏ 1 file (Google trả font biến thể, 1 file chứa
// nhiều độ đậm) nên không tốn thêm request nào, chỉ khai rõ từng độ đậm thực sự dùng
// trong mail để trình duyệt khớp đúng mặt chữ, tránh phải tự "giả đậm" (synthetic bold) —
// đây chính là nguyên nhân vỡ dấu tiếng Việt đã gặp với Georgia trước đó.
function montserratFace(weight) {
    return `
@font-face{font-family:'Montserrat';font-style:normal;font-weight:${weight};font-display:swap;src:url('https://fonts.gstatic.com/s/montserrat/v31/JTUSjIg1_i6t8kCHKm459WZhyzbi.woff2') format('woff2');unicode-range:U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB;}
@font-face{font-family:'Montserrat';font-style:normal;font-weight:${weight};font-display:swap;src:url('https://fonts.gstatic.com/s/montserrat/v31/JTUSjIg1_i6t8kCHKm459Wlhyw.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}`;
}
const FONT_FACE_CSS = `
${[400, 600, 700, 800].map(montserratFace).join("")}
@font-face{font-family:'Oswald';font-style:normal;font-weight:700;font-display:swap;src:url('https://fonts.gstatic.com/s/oswald/v57/TK3IWkUHHAIjg75cFRf3bXL8LICs1_Fv40pKlN4NNSeSASz7FmlZHYjedg.woff2') format('woff2');unicode-range:U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB;}
@font-face{font-family:'Oswald';font-style:normal;font-weight:700;font-display:swap;src:url('https://fonts.gstatic.com/s/oswald/v57/TK3IWkUHHAIjg75cFRf3bXL8LICs1_Fv40pKlN4NNSeSASz7FmlWHYg.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}`;

function fmtVND(n) {
    return n.toLocaleString("vi-VN") + "đ";
}

// showtimeId dạng "2026-09-25_17:30" -> { time: "17:30", date: "25/09/2026" }
function splitShowtime(showtimeId) {
    const [datePart, timePart] = showtimeId.split("_");
    const [y, m, d] = datePart.split("-");
    return { time: timePart, date: `${d}/${m}/${y}` };
}

// Ảnh QR thật (không phải base64 nhúng trong HTML) — nhiều mail client tự
// strip ảnh dạng data:base64 nhúng qua API vì lý do chống spam, khiến QR
// không hiện được (src rỗng). Dùng URL thật do backend tự vẽ thay vì nhúng.
function qrImgUrl(ticketCode) {
    return `${PUBLIC_API_BASE}/api/tickets/${encodeURIComponent(ticketCode)}/qr.png`;
}

function infoRow(icon, label, value) {
    return `
    <tr>
        <td style="padding:7px 0;vertical-align:top;width:26px;font-size:15px;">${icon}</td>
        <td style="padding:7px 0;vertical-align:top;width:150px;color:#98a29b;font-size:12.5px;">${label}</td>
        <td style="padding:7px 0;vertical-align:top;color:#E6F1EA;font-size:14px;font-weight:600;">${value}</td>
    </tr>`;
}

// Mỗi vé xếp riêng 1 hàng (dọc), không xếp chung hàng ngang — nhiều vé đặt sát
// nhau trong cùng 1 hàng từng khiến máy quét check-in dễ bắt nhầm mã bên cạnh khi
// đưa điện thoại lại gần. Có đường kẻ phân tách + khoảng cách rộng giữa các vé.
function qrBlockHtml(ticket, index, total) {
    const divider = index > 0
        ? `<div style="height:1px;background:rgba(255,255,255,.1);margin:0 auto 26px;max-width:220px;"></div>`
        : "";
    const numberLabel = total > 1
        ? `<div style="color:#98a29b;font-size:10.5px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">Vé ${index + 1}/${total}</div>`
        : "";
    return `
    <tr>
        <td align="center" style="padding:${index === 0 ? "6px" : "26px"} 20px 6px;">
            ${divider}
            ${numberLabel}
            <img src="${qrImgUrl(ticket.ticketCode)}" width="160" height="160" alt="QR vé ${ticket.ticketCode}" style="display:block;margin:0 auto;border-radius:10px;background:#fff;padding:12px;">
            <div style="color:#E6F1EA;font-size:14px;font-weight:700;margin-top:10px;">Ghế ${ticket.seatId}${ticket.tierName ? ` — ${ticket.tierName}` : ""}</div>
        </td>
    </tr>`;
}

async function buildTicketEmailHtml(order, tickets) {

    const { time, date } = splitShowtime(order.showtimeId);

    const tierSummary = [...new Set(tickets.map((t) => t.tierName))].join(", ");
    const seatSummary = tickets.map((t) => t.seatId).join(", ");

    const qrThumbs = tickets
        .map((t, i) => qrBlockHtml(t, i, tickets.length))
        .join("");

    return `
    <div style="background:#04060a;padding:0;">
    <style>${FONT_FACE_CSS}</style>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;font-family:'Montserrat','Be Vietnam Pro',sans-serif;background:#0d1117;">

        <!-- HERO -->
        <tr>
            <td>
                <img src="${HERO_IMG}" width="560" alt="Sơn Thần Thủy Quái" style="display:block;width:100%;max-width:560px;height:auto;">
            </td>
        </tr>

        <!-- LOGO + TITLE -->
        <tr>
            <td style="background:#0d1117;text-align:center;padding:24px 24px 20px;">
                <img src="${LOGO_IMG}" width="200" alt="LumiShow" style="display:block;width:200px;max-width:60%;height:auto;margin:0 auto 18px;">
                <img src="${TITLE_IMG}" width="320" alt="Sơn Thần Thủy Quái" style="display:block;width:100%;max-width:320px;height:auto;margin:0 auto 10px;">
                <div style="color:#98a29b;font-size:11px;letter-spacing:1px;text-transform:uppercase;">Show xiếc kết hợp 3D Mapping Panorama 360°</div>
                <div style="color:#7CFF5A;font-size:11.5px;font-weight:700;margin-top:8px;">◆ &nbsp;LumiShow kết hợp cùng Rạp Xiếc Trung Ương&nbsp; ◆</div>
            </td>
        </tr>

        <!-- CONFIRM HEADING -->
        <tr>
            <td style="background:#0d1117;text-align:center;padding:0 24px 24px;">
                <!-- Oswald tối đa chỉ có weight 700 (không có 800) — giữ đúng 700 để khớp
                     @font-face khai báo, tránh trình duyệt phải tự giả đậm (synthetic bold)
                     khi không tìm thấy đúng mặt chữ, nguyên nhân từng gây vỡ dấu tiếng Việt. -->
                <div style="font-family:'Oswald','Arial Narrow',sans-serif;color:#FFD15A;font-size:21px;font-weight:700;letter-spacing:.5px;">XÁC NHẬN ĐẶT VÉ THÀNH CÔNG</div>
                <div style="color:#98a29b;font-size:12.5px;margin-top:6px;">Sơn Thần Thủy Quái&nbsp; | &nbsp;Mã vé #${order.orderCode}</div>
            </td>
        </tr>

        <tr>
            <td style="background:#0d1117;color:#E6F1EA;padding:0 24px 28px;">

                <p style="margin:0 0 14px;font-size:15px;">Chào <b>${order.customerName}</b>,</p>

                <p style="margin:0 0 24px;font-size:14px;line-height:1.7;color:#c9d1cb;">
                    Cảm ơn bạn đã đặt vé xem <b style="color:#FFD15A;">Sơn Thần Thủy Quái</b> — show xiếc kết hợp 3D Mapping
                    Panorama 360° do LumiShow kết hợp cùng Rạp Xiếc Trung Ương thực hiện.
                    Đơn hàng của bạn đã được thanh toán và xác nhận thành công.
                </p>

                <!-- THÔNG TIN VÉ -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                    style="border:1px solid rgba(255,209,90,.35);border-radius:14px;margin-bottom:22px;background:#10151c;">
                    <tr>
                        <td style="padding:18px 20px;">
                            <div style="color:#FFD15A;font-size:13px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;margin-bottom:10px;">🎫&nbsp; Thông tin vé</div>
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                ${infoRow("🔖", "Mã đặt chỗ", `#${order.orderCode}`)}
                                ${infoRow("🎪", "Tên chương trình", "Sơn Thần Thủy Quái")}
                                ${infoRow("🕐", "Thời gian", `${time}, ${date}`)}
                                ${infoRow("📍", "Địa điểm", `${VENUE_NAME}<br>${VENUE_ADDRESS}`)}
                                ${infoRow("👥", "Số lượng vé", `${tickets.length} vé`)}
                                ${infoRow("💺", "Loại vé / Ghế", `${tierSummary} — ${seatSummary}`)}
                                ${infoRow("💰", "Tổng tiền", `<span style="color:#7CFF5A;">${fmtVND(order.amount)}</span>`)}
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td align="center" style="padding:4px 20px 20px;border-top:1px solid rgba(255,255,255,.08);">
                            <div style="color:#98a29b;font-size:11px;margin:14px 0 12px;text-align:center;">📱&nbsp; Mã QR vé — quét để check-in tại rạp</div>
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${qrThumbs}</table>
                        </td>
                    </tr>
                </table>

                <!-- THÔNG TIN NGƯỜI ĐẶT -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                    style="border:1px solid rgba(255,255,255,.1);border-radius:14px;margin-bottom:22px;background:#10151c;">
                    <tr>
                        <td style="padding:18px 20px;">
                            <div style="color:#FFD15A;font-size:13px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;margin-bottom:12px;">👤&nbsp; Thông tin người đặt vé</div>
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td width="34%" style="color:#98a29b;font-size:11.5px;padding-bottom:3px;">Họ và tên</td>
                                    <td width="33%" style="color:#98a29b;font-size:11.5px;padding-bottom:3px;">Số điện thoại</td>
                                    <td width="33%" style="color:#98a29b;font-size:11.5px;padding-bottom:3px;">Email</td>
                                </tr>
                                <tr>
                                    <td style="color:#E6F1EA;font-size:13.5px;font-weight:700;">${order.customerName}</td>
                                    <td style="color:#E6F1EA;font-size:13.5px;font-weight:700;">${order.customerPhone || "—"}</td>
                                    <td style="color:#E6F1EA;font-size:13.5px;font-weight:700;word-break:break-all;">${order.customerEmail}</td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>

                <!-- NỘI QUY -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                    style="border:1px solid rgba(255,255,255,.1);border-radius:14px;margin-bottom:22px;background:#10151c;">
                    <tr>
                        <td style="padding:18px 20px;">
                            <div style="color:#FFD15A;font-size:13px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;margin-bottom:10px;">🛡️&nbsp; Nội quy khi vào rạp</div>
                            <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.8;color:#c9d1cb;">
                                <li>Vui lòng có mặt trước giờ diễn 30 phút để làm thủ tục check-in.</li>
                                <li>Ban tổ chức không giải quyết các trường hợp phát sinh sau khi chương trình bắt đầu.</li>
                                <li>Không mang đồ ăn, thức uống vào khu vực khán phòng.</li>
                                <li>Không hút thuốc, sử dụng thuốc lá điện tử hoặc vape trong rạp.</li>
                                <li>Vui lòng giữ trật tự, không nói chuyện lớn và không xả rác trong khán phòng.</li>
                                <li>Vui lòng lựa chọn trang phục lịch sự, phù hợp khi đến xem chương trình.</li>
                                <li>Không sử dụng máy ảnh chuyên nghiệp, GoPro, drone, flycam, gimbal hoặc tripod trong suốt buổi diễn.</li>
                                <li>Không mang các vật dễ cháy, chất nổ hoặc chất cấm vào trong rạp.</li>
                                <li>Vé đã mua không được hoàn, hủy hoặc đổi trong bất kỳ trường hợp nào.</li>
                                <li>Vui lòng mang theo mã QR hoặc mã đặt chỗ để xuất trình khi check-in. Mỗi mã vé chỉ được sử dụng một lần; vui lòng không chia sẻ mã QR hoặc mã đặt chỗ cho người khác.</li>
                            </ul>
                        </td>
                    </tr>
                </table>

                <!-- FOOTER MESSAGE -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                    style="border:1px solid rgba(255,255,255,.1);border-radius:14px;background:#10151c;">
                    <tr>
                        <td style="padding:18px 20px;">
                            <p style="font-size:13px;color:#c9d1cb;margin:0 0 4px;">🎧&nbsp; Nếu cần hỗ trợ, vui lòng liên hệ</p>
                            <p style="font-size:14px;color:#FFD15A;font-weight:800;margin:0 0 16px;">HOTLINE: ${SUPPORT_HOTLINE}</p>
                            <p style="font-size:13px;color:#c9d1cb;margin:0 0 18px;">Chúc bạn có một trải nghiệm đáng nhớ cùng Sơn Thần Thủy Quái.</p>
                            <p style="font-size:13px;color:#c9d1cb;margin:0;">Trân trọng,</p>
                            <p style="font-style:italic;font-weight:700;color:#FFD15A;font-size:20px;margin:2px 0 0;">Lumishow</p>
                        </td>
                    </tr>
                </table>

            </td>
        </tr>

        <tr>
            <td style="background:#0d1117;padding:16px 24px;text-align:center;border-top:1px solid rgba(255,255,255,.08);">
                <p style="font-size:11px;color:#636d66;margin:0;">Đây là email tự động từ hệ thống LumiShow, vui lòng không trả lời trực tiếp email này.</p>
            </td>
        </tr>

    </table>
    </div>`;
}

// Gửi mail vé qua Resend API (dùng fetch trực tiếp, không cần SDK riêng).
// Không throw ra ngoài để lỗi gửi mail không làm hỏng luồng xác nhận thanh toán —
// gọi nơi dùng hàm này nên tự bọc try/catch hoặc dùng .catch().
async function sendTicketEmail(order, tickets) {

    if (!RESEND_API_KEY) {
        console.warn("[email] RESEND_API_KEY chưa cấu hình — bỏ qua gửi mail vé.");
        return;
    }

    if (!order.customerEmail) {
        console.warn("[email] Đơn hàng không có email khách — bỏ qua gửi mail vé.");
        return;
    }

    const html = await buildTicketEmailHtml(order, tickets);

    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            from: EMAIL_FROM,
            to: order.customerEmail,
            subject: `Xác nhận đặt vé thành công - Sơn thần thủy quái | Mã vé #${order.orderCode}`,
            html
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gửi mail vé thất bại (${response.status}): ${errText}`);
    }
}

// Mail nội bộ báo có khách đặt vé thành công — riêng cho LumiShow theo dõi đơn,
// khác hẳn mail vé gửi khách (không hero, không QR, không nội quy). Cố tình tối
// giản: chỉ đúng những gì cần biết ngay (khách nào, ghế nào, suất nào, bao nhiêu
// tiền) xếp thành 1 khối thông tin duy nhất, dễ liếc qua trên điện thoại.
function buildOrderNotificationHtml(order, tickets) {

    const { time, date } = splitShowtime(order.showtimeId);
    const seatList = tickets.map((t) => t.seatId).join(", ");
    const tierSummary = [...new Set(tickets.map((t) => t.tierName))].join(", ");

    return `
    <div style="background:#04060a;padding:24px;">
    <style>${FONT_FACE_CSS}</style>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;font-family:'Montserrat','Be Vietnam Pro',sans-serif;background:#0d1117;border-radius:14px;overflow:hidden;">
        <tr>
            <td style="padding:22px 24px;">
                <div style="font-family:'Oswald','Arial Narrow',sans-serif;color:#FFD15A;font-size:17px;font-weight:700;letter-spacing:.5px;margin-bottom:2px;">🎟️&nbsp; ĐƠN VÉ MỚI</div>
                <div style="color:#98a29b;font-size:12px;margin-bottom:16px;">Mã đơn #${order.orderCode} — Sơn Thần Thủy Quái</div>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(255,255,255,.1);border-radius:12px;background:#10151c;">
                    <tr><td style="padding:16px 18px;">
                        ${infoRow("👤", "Khách hàng", escapeHtml(order.customerName))}
                        ${infoRow("📞", "SĐT", `<a href="tel:${escapeHtml(order.customerPhone)}" style="color:#E6F1EA;">${escapeHtml(order.customerPhone)}</a>`)}
                        ${infoRow("✉️", "Email", `<a href="mailto:${escapeHtml(order.customerEmail)}" style="color:#E6F1EA;">${escapeHtml(order.customerEmail)}</a>`)}
                        ${infoRow("🕐", "Suất diễn", `${time}, ${date}`)}
                        ${infoRow("💺", "Ghế", `${seatList} <span style="color:#98a29b;font-weight:400;">(${tierSummary})</span>`)}
                        ${infoRow("💰", "Tổng tiền", `<span style="color:#7CFF5A;">${fmtVND(order.amount)}</span>`)}
                    </td></tr>
                </table>
            </td>
        </tr>
    </table>
    </div>`;
}

// Mail cảnh báo NỘI BỘ khi đơn đã thanh toán thật (tiền đã về tài khoản) nhưng 1
// hoặc nhiều ghế trong đơn đã bị người khác giữ/mua mất giữa chừng (hold hết hạn
// trước khi hệ thống kịp xác nhận thanh toán — xem finalizeOrderAsPaid trong
// payment.service.js). Hệ thống KHÔNG tự quyết định đổi ghế/hoàn tiền được nên
// cần người xử lý tay ngay — mail cố tình nổi bật (viền đỏ, chủ đề có ⚠️) để
// không bị lẫn với các mail "đơn vé mới" bình thường.
function buildSeatConflictAlertHtml(order, conflictSeats) {

    const { time, date } = splitShowtime(order.showtimeId);
    const seatList = conflictSeats.map((s) => `${s.seatId} (đang ${s.seatStatus})`).join(", ");

    return `
    <div style="background:#04060a;padding:24px;">
    <style>${FONT_FACE_CSS}</style>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;font-family:'Montserrat','Be Vietnam Pro',sans-serif;background:#0d1117;border-radius:14px;overflow:hidden;border:2px solid #FF5A5A;">
        <tr>
            <td style="padding:22px 24px;">
                <div style="font-family:'Oswald','Arial Narrow',sans-serif;color:#FF5A5A;font-size:16px;font-weight:700;letter-spacing:.5px;margin-bottom:2px;">⚠️&nbsp; XUNG ĐỘT GHẾ — CẦN XỬ LÝ TAY NGAY</div>
                <div style="color:#98a29b;font-size:12px;margin-bottom:16px;">Mã đơn #${order.orderCode} — khách đã thanh toán thật, nhưng ghế bên dưới đã bị giữ/bán cho người khác trước khi hệ thống kịp xác nhận.</div>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(255,90,90,.4);border-radius:12px;background:#10151c;">
                    <tr><td style="padding:16px 18px;">
                        ${infoRow("👤", "Khách hàng", escapeHtml(order.customerName))}
                        ${infoRow("📞", "SĐT", `<a href="tel:${escapeHtml(order.customerPhone)}" style="color:#E6F1EA;">${escapeHtml(order.customerPhone)}</a>`)}
                        ${infoRow("✉️", "Email", `<a href="mailto:${escapeHtml(order.customerEmail)}" style="color:#E6F1EA;">${escapeHtml(order.customerEmail)}</a>`)}
                        ${infoRow("🕐", "Suất diễn", `${time}, ${date}`)}
                        ${infoRow("💺", "Ghế xung đột", escapeHtml(seatList))}
                        ${infoRow("💰", "Số tiền đã nhận", `<span style="color:#7CFF5A;">${fmtVND(order.amount)}</span>`)}
                    </td></tr>
                </table>

                <p style="color:#c9d1cb;font-size:12.5px;line-height:1.7;margin:16px 0 0;">Cần liên hệ khách để đổi sang ghế còn trống khác, hoặc hoàn tiền — hệ thống đã ghi nhận đơn PAID nhưng KHÔNG tự gán ghế để tránh tạo trùng vé với người đang giữ/đã mua ghế đó.</p>
            </td>
        </tr>
    </table>
    </div>`;
}

async function sendSeatConflictAlertEmail(order, conflictSeats) {

    if (!RESEND_API_KEY) {
        console.warn("[email] RESEND_API_KEY chưa cấu hình — bỏ qua gửi mail cảnh báo xung đột ghế.");
        return;
    }

    const html = buildSeatConflictAlertHtml(order, conflictSeats);

    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            from: EMAIL_FROM,
            to: TECH_ALERT_EMAILS,
            subject: `⚠️ XUNG ĐỘT GHẾ — Đơn #${order.orderCode} đã thanh toán nhưng ghế bị trùng`,
            html
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gửi mail cảnh báo xung đột ghế thất bại (${response.status}): ${errText}`);
    }
}

// Không throw ra ngoài — cùng lý do với sendTicketEmail: lỗi gửi mail nội bộ
// không được phép làm hỏng luồng xác nhận thanh toán của khách.
async function sendOrderNotificationEmail(order, tickets) {

    if (!RESEND_API_KEY) {
        console.warn("[email] RESEND_API_KEY chưa cấu hình — bỏ qua gửi mail thông báo đơn.");
        return;
    }

    const html = buildOrderNotificationHtml(order, tickets);

    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            from: EMAIL_FROM,
            to: ORDER_NOTIFY_EMAILS,
            subject: `🎟️ Đơn vé mới #${order.orderCode} — ${order.customerName} (${tickets.length} ghế)`,
            html
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gửi mail thông báo đơn thất bại (${response.status}): ${errText}`);
    }
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function buildContactEmailHtml({ name, phone, email, company, message }) {

    return `
    <div style="background:#04060a;padding:24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;background:#0d1117;border-radius:14px;overflow:hidden;">
        <tr>
            <td style="padding:24px;">
                <div style="color:#FFD15A;font-size:18px;font-weight:800;margin-bottom:4px;">Liên hệ mới từ website LumiShow</div>
                <div style="color:#98a29b;font-size:12px;margin-bottom:20px;">Biểu mẫu "Gửi thông tin liên hệ trao đổi công việc" — trang Liên hệ</div>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(255,255,255,.1);border-radius:12px;background:#10151c;">
                    <tr><td style="padding:16px 18px;">
                        ${infoRow("👤", "Họ và tên", escapeHtml(name))}
                        ${infoRow("📞", "Số điện thoại", `<a href="tel:${escapeHtml(phone)}" style="color:#E6F1EA;">${escapeHtml(phone)}</a>`)}
                        ${infoRow("✉️", "Email", `<a href="mailto:${escapeHtml(email)}" style="color:#E6F1EA;">${escapeHtml(email)}</a>`)}
                        ${infoRow("🏢", "Công ty", company ? escapeHtml(company) : "—")}
                    </td></tr>
                </table>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(255,255,255,.1);border-radius:12px;margin-top:16px;background:#10151c;">
                    <tr><td style="padding:16px 18px;">
                        <div style="color:#98a29b;font-size:11.5px;margin-bottom:8px;">Nội dung trao đổi</div>
                        <div style="color:#E6F1EA;font-size:14px;line-height:1.7;white-space:pre-wrap;">${escapeHtml(message)}</div>
                    </td></tr>
                </table>
            </td>
        </tr>
    </table>
    </div>`;
}

// Gửi mail thông báo liên hệ mới (form trang Liên hệ) về hộp thư công ty qua Resend API.
async function sendContactEmail({ name, phone, email, company, message }) {

    if (!RESEND_API_KEY) {
        console.warn("[email] RESEND_API_KEY chưa cấu hình — bỏ qua gửi mail liên hệ.");
        throw new Error("Hệ thống email chưa được cấu hình");
    }

    const html = buildContactEmailHtml({ name, phone, email, company, message });

    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            from: EMAIL_FROM,
            to: CONTACT_TO_EMAILS,
            reply_to: email,
            subject: `[LumiShow] Liên hệ mới từ ${name}`,
            html
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gửi mail liên hệ thất bại (${response.status}): ${errText}`);
    }
}

module.exports = {
    sendTicketEmail,
    sendOrderNotificationEmail,
    sendSeatConflictAlertEmail,
    sendContactEmail
};
