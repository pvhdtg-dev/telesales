# Kết quả kiểm tra — 21/10/2026

- 17/17 kiểm thử tự động đạt. Chạy PostgreSQL qua PGlite 0.5.10; kiểm tra RLS thực sự với các vai trò `anon`, `authenticated` và tài khoản giả quản trị/A/B. Kiểm tra bổ sung: user của ứng dụng khác không tự được tạo profile hoặc cấp quyền telesales trong dự án dùng chung.
- Đã kiểm tra không đọc chéo khách, không tự nâng quyền, không giả mạo người/thời gian, không sửa/xóa nhật ký, chống ghi trùng khi gửi lại cùng ID, chuyển giao giữ lịch sử, thu hồi quyền khi khóa tài khoản, quyền file âm thanh, thống kê cá nhân sau chuyển khách và dữ liệu nhập cũ không làm tăng số cuộc gọi.
- Kiểm tra giải mã HTML cũ bằng PBKDF2/AES-GCM, không chạy script trong file nhập; chuẩn hóa ID, chống trùng và kiểm tra khoảng ngày Việt Nam/CSV.
- Kiểm tra cú pháp JavaScript và TypeScript của Edge Function đạt. Mọi tài nguyên cục bộ được HTML tham chiếu đều có trong gói.
- Đã xem giao diện máy tính và khung 390px bằng trình duyệt với dữ liệu giả tách riêng. Khung điện thoại không tràn ngang; thử form lưu chăm sóc tạo được dòng lịch sử hiển thị; giao diện nhân viên không hiện công cụ quản trị.
- Gói phát hành không chứa dữ liệu khách hàng, mật khẩu, khóa máy chủ hay bộ dữ liệu giả dùng kiểm tra.

## Chưa được kiểm tra trên hệ thống thật

Người dùng đã chuyển sang dự án Supabase riêng `yzodjhjghcxrvtmyuayu`. Lượt kiểm tra metadata và danh sách bảng của dự án mới đều trả lỗi không có quyền truy cập. GitHub đang dùng `phamvanho898-crypto`, chưa có quyền ghi repo `pvhdtg-dev/telesales`. URL mới đã được điền vào cấu hình, publishable key vẫn để trống. Vì vậy chưa áp dụng schema thật, chưa cấp tài khoản thật, chưa triển khai Edge Function, chưa nhập khách hàng và chưa kiểm tra đăng nhập/Storage/đồng bộ qua hai thiết bị trên mạng. Cần chạy lượt nghiệm thu bằng 1 quản trị + 2 nhân viên trước khi sử dụng chính thức. Chưa chạy Supabase Advisors trên dự án thật.

Đồng bộ trong V1 dùng kiểm tra mỗi 15 giây khi tab đang mở, không dùng WebSocket và không có hàng đợi làm việc offline.
