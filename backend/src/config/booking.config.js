const BOOKING_CONFIG = {
    // Tối đa số ghế được giữ trong một lượt booking
    MAX_SEATS_PER_ORDER: 6,

    // Thời gian giữ ghế: 10 phút
    HOLD_DURATION_MS: 10 * 60 * 1000,

    // Chỉ cho một booking session có một hold đang hoạt động
    MAX_ACTIVE_HOLDS_PER_SESSION: 1
};

module.exports = BOOKING_CONFIG;