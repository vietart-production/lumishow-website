const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "LumiShow <booking@lumishow.vn>";

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
const TITLE_IMG = `${ASSET_BASE}/textSTTQ.png`;
const LOGO_IMG = `${ASSET_BASE}/logo-lumishow.png`;

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

function qrThumbHtml(ticket) {
    return `
    <td align="center" style="padding:0 10px 14px;">
        <img src="${qrImgUrl(ticket.ticketCode)}" width="150" height="150" alt="QR vé ${ticket.ticketCode}" style="display:block;border-radius:10px;background:#fff;padding:10px;">
        <div style="color:#E6F1EA;font-size:13px;font-weight:700;margin-top:8px;">${ticket.seatId}</div>
    </td>`;
}

async function buildTicketEmailHtml(order, tickets) {

    const { time, date } = splitShowtime(order.showtimeId);

    const tierSummary = [...new Set(tickets.map((t) => t.tierName))].join(", ");
    const seatSummary = tickets.map((t) => t.seatId).join(", ");

    const qrThumbs = tickets
        .map((t) => qrThumbHtml(t))
        .join("");

    return `
    <div style="background:#04060a;padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;background:#0d1117;">

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
                <div style="color:#FFD15A;font-size:20px;font-weight:800;letter-spacing:.5px;">XÁC NHẬN ĐẶT VÉ THÀNH CÔNG</div>
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
                            <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr>${qrThumbs}</tr></table>
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
                            <p style="font-family:'Brush Script MT',cursive;font-style:italic;color:#FFD15A;font-size:22px;margin:2px 0 0;">Lumishow</p>
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

module.exports = {
    sendTicketEmail
};
