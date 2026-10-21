# Telesales Team V1

Bản nâng cấp cho `pvhdtg-dev/telesales`: đăng nhập cá nhân, giao khách, lịch sử từng lần chăm sóc, đồng bộ máy tính/điện thoại và báo cáo theo nhân viên. Giao diện tĩnh vẫn dùng GitHub Pages; Supabase chịu trách nhiệm dữ liệu và phân quyền.

**Tình trạng bàn giao 21/10/2026:** mã nguồn và kiểm thử đã chuẩn bị. Người dùng đã chuyển telesales sang dự án riêng `yzodjhjghcxrvtmyuayu`; URL `https://yzodjhjghcxrvtmyuayu.supabase.co` đã được điền vào `config.js`. Supabase hiện trả lỗi không có quyền truy cập dự án mới. GitHub đang kết nối tài khoản `phamvanho898-crypto`; repo `pvhdtg-dev/telesales` chưa có quyền ghi qua kết nối này. Chưa đưa mã lên website, chưa áp dụng schema, chưa nhập dữ liệu thật và chưa có publishable key trong cấu hình.

## Những gì bản này thực hiện

- Quản trị xem danh bạ, thêm khách, chọn nhiều khách để giao/chuyển hoặc thu hồi phân công.
- Mỗi nhân viên chỉ đọc và ghi nhận chăm sóc cho khách đang được giao. Quyền được kiểm tra tại database, kể cả khi gọi API trực tiếp.
- Mỗi lần lưu là một sự kiện riêng. Người thực hiện và thời gian do máy chủ xác định. Trình duyệt không được sửa/xóa lịch sử.
- Cuộc gọi, ghi chú, kết quả, hẹn gọi lại và âm thanh đính kèm (25 MB/file). Âm thanh dùng bucket riêng tư và quyền theo khách.
- Khi chuyển khách, nhân viên cũ mất quyền đọc hồ sơ; nhân viên mới xem được các lần chăm sóc trước. Báo cáo vẫn ghi nhận tổng số việc cho người đã làm.
- Lưu lên máy chủ ngay khi bấm Lưu. Các thiết bị đang mở tự kiểm tra dữ liệu mỗi 15 giây; mở lại tab cũng làm mới. Có nút cập nhật thủ công.
- Báo cáo theo ngày Việt Nam, phân biệt số cuộc gọi/ghi chú trong kỳ và số khách/tiềm năng/quá hạn hiện tại. Chỉ quản trị xuất CSV tổng hợp.
- Không tự ghi nhận cuộc gọi chỉ vì bấm số điện thoại. Số lần gọi trong báo cáo là số lần người dùng chủ động ghi nhận, không phải dữ liệu tổng đài xác nhận kết nối.
- Không lưu danh bạ vào localStorage hoặc service worker. Phiên đăng nhập nằm trong sessionStorage của tab; dữ liệu công việc phải có mạng để lưu.

## Triển khai khi đã có quyền kết nối

1. Sao lưu JSON ghi chú trên **từng máy/trình duyệt** đang dùng app cũ. Giữ một bản HTML cũ riêng trên máy quản trị để nhập danh bạ, không đưa bản sao HTML đó lên website mới. Nếu cần giữ âm thanh cũ, tải riêng các file âm thanh trước khi dọn dữ liệu trình duyệt.
2. Dự án riêng đã được chọn: `yzodjhjghcxrvtmyuayu`. Kết nối lại Supabase bằng tài khoản mới có quyền quản lý dự án rồi kiểm tra bảng và policy hiện có trước khi chạy. Cấu hình hiện tại chỉ dùng dự án mới này cho telesales; dự án kho Camtech đã được bỏ khỏi cấu hình.
3. Chạy toàn bộ `supabase/schema.sql` một lần trong SQL Editor. Script nằm trong transaction. Không chạy lại sau khi đã áp dụng thành công. Dự án đã có cấu trúc `ts_` cần được kiểm tra trước.
4. Giữ cấu hình Authentication chung của dự án đang sử dụng. Không tự tạo profile telesales cho user của ứng dụng khác; user chưa có profile sẽ không có quyền truy cập dữ liệu telesales. Tạo tài khoản quản trị đầu tiên bằng **Create user** trong Dashboard (hoặc dùng user có sẵn sau khi đối chiếu đúng chủ tài khoản); dùng email thật và mật khẩu do người quản trị tự đặt. Chạy đoạn SQL ở phần tiếp theo để cấp quyền quản trị. Không có tài khoản hay mật khẩu mặc định trong gói.
5. Triển khai Edge Function tên `telesales-users` từ `supabase/functions/telesales-users/index.ts`. Function tự kiểm tra access token bằng `auth.getUser` và tra quyền quản trị đang hoạt động trong database. `verify_jwt=false` trong `supabase/config.toml` chỉ tắt lớp kiểm tra JWT cũ của gateway; không bỏ xác thực bên trong function. Đặt `ALLOWED_ORIGINS=https://pvhdtg-dev.github.io`. Giữ `SUPABASE_SERVICE_ROLE_KEY` trong môi trường máy chủ Supabase, không chép vào mã website.
6. `supabaseUrl` đã được điền theo dự án đã chọn. Sau khi kết nối có quyền, lấy **publishable key** `sb_publishable_...` của đúng dự án và điền vào `config.js`. Đây là khóa công khai; quyền dữ liệu nằm ở RLS. Không điền secret/service_role key. App vẫn khóa đăng nhập khi chưa có publishable key.
7. Cập nhật các file trong gói vào repo `pvhdtg-dev/telesales`. Hai file HTML của bản cũ phải được thay: `index.html` là app mới, `GOI_DIEN_KHACH_HANG_THEO_KHU_VUC.html` chỉ chuyển hướng về app mới. Giữ nguyên cấu hình Pages hiện tại. Các icon cũ có thể giữ lại, không bắt buộc cho bản này.
8. Mở website, đăng nhập quản trị. Trong **Chuyển dữ liệu cũ**, nhập HTML danh bạ cũ và mật khẩu danh bạ. Mật khẩu chỉ dùng giải mã tại trình duyệt, không gửi lên Supabase. Nhập từng JSON sao lưu của các máy. Kiểm tra số lượng trước khi giao khách.
9. Tạo tài khoản nhân viên tại mục **Nhân viên**, bàn giao thông tin đăng nhập trực tiếp. Tài khoản được tạo bởi quản trị, không tự gửi email. Chọn khách → chọn nhân viên → **Giao khách**.
10. Thử bằng một quản trị và hai nhân viên trên máy tính/điện thoại: lưu một cuộc gọi, chờ đồng bộ, chuyển khách, kiểm tra quyền cũ/mới, khóa thử tài khoản và đối chiếu báo cáo. Chỉ mở rộng phân công khi lượt thử này đạt.

## Cấp quyền cho quản trị đầu tiên

Sau khi tạo user trong Dashboard, thay email trong đoạn SQL rồi chạy. Không đặt mật khẩu bằng SQL.

```sql
insert into public.ts_profiles(id,full_name,role,active)
select id,'Quản trị Telesales','admin',true
from auth.users where email='THAY_EMAIL_QUAN_TRI'
on conflict(id) do update set role='admin', active=true, full_name=excluded.full_name
returning id, full_name, role, active;
```

Kết quả phải có đúng một dòng. Nếu chưa có dòng, kiểm tra email/user và schema trước khi tiếp tục.

## Chuyển dữ liệu: cách xử lý rõ ràng

- ID cũ là `legacy_id`, không gán quyền bằng chuỗi tên Sales cũ. Khách mới nhập ở trạng thái chưa phân công.
- Ghi chú, trạng thái và thời gian có sẵn trong HTML được giữ ở phần ghi chú gốc. Nhật ký từ từng JSON được lưu với loại **Nhập dữ liệu cũ**, do quản trị nhập, kèm thời gian gốc ghi rõ chưa xác minh.
- Nhật ký cũ không được coi là cuộc gọi mới và không ghi đè trạng thái/ghi chú làm việc mới. Quản trị có thể tham khảo lịch sử và ghi nhận trạng thái hiện tại sau khi kiểm tra.
- Dùng khóa băm nội dung để bỏ qua ghi chú cũ đã nhập. Các ID chưa có trong danh bạ được báo đếm để bổ sung rồi nhập lại.
- JSON của app cũ chỉ chứa ID âm thanh; nó không chứa file âm thanh. Cần đính kèm lại file riêng. Những lần chỉnh sửa đã bị ghi đè trong app cũ không thể phục dựng.
- Công cụ không xóa localStorage cũ. Chỉ xóa mật khẩu mở danh bạ đã ghi nhớ khi đăng nhập app mới thành công.
- Phân quyền mới áp dụng dữ liệu trên máy chủ. Bản danh bạ cũ đã tải xuống hoặc còn trong các commit cũ không tự bị thu hồi.

## Kiểm thử

```bash
npm ci --ignore-scripts
npm test
npm run check
```

PostgreSQL chạy qua PGlite để kiểm thử RLS thực tế với ba vai trò/tài khoản giả. Kiểm thử bao gồm truy cập chéo, leo quyền, bất biến nhật ký, chuyển khách, khóa nhân viên, âm thanh, báo cáo, nhập cũ và gửi lại cùng ID. Schema `auth`/`storage` trong bài kiểm thử là mô phỏng tối thiểu; không thay thế kiểm thử dịch vụ Auth/Storage/Edge Function của Supabase thật.

Giao diện được xem thử ở chiều rộng máy tính và khung 390px với dữ liệu giả tách riêng, không có trong gói phát hành. Chưa thể kiểm chứng đăng nhập, cấp tài khoản, tải âm thanh và đồng bộ qua hai thiết bị trên dự án thật.

## Các file chính

| File | Vai trò |
| --- | --- |
| `index.html`, `assets/style.css`, `assets/app.js` | Giao diện và thao tác công việc |
| `config.js` | URL dự án + publishable key |
| `assets/migration.js` | Nhập danh bạ, ghi chú và xử lý ngày báo cáo |
| `supabase/schema.sql` | Bảng, quyền, nhật ký, báo cáo và âm thanh riêng tư |
| `supabase/functions/telesales-users/index.ts` | Cấp tài khoản bởi quản trị |
| `sw.js` | Loại cache app cũ, không cache dữ liệu khách hàng |
| `tests/` | Bộ kiểm thử |

Supabase JS 2.118.0 được lưu kèm ở `assets/vendor` để không phụ thuộc CDN khi tải app. Giấy phép kèm theo. `package-lock.json` khóa phiên bản phụ thuộc để chạy kiểm thử lại.
