# Duyệt giá Tuấn Tú

Extension Chrome dạng "loader": chỉ cài **một lần**, còn code thật nằm trong thư mục
`scripts/` trên GitHub. Mỗi khi push code mới, mọi máy đã cài sẽ tự tải về và chạy bản mới,
không cần cài lại hay bấm reload extension.

```
extension/   # cài vào Chrome (Load unpacked) – hiếm khi phải sửa
scripts/     # code chạy trên trang web – sửa và push thoải mái
  manifest.json
  bao-gia/hook.js    # nghe dữ liệu báo giá + bình luận mà CRM tự tải về
  bao-gia/panel.js   # bảng "Đánh giá NVKD" + gọi Claude
```

## Đánh giá nhân viên kinh doanh (sale.tuantu.com.vn)

1. Trong popup extension → **Cài đặt**, nhập **Anthropic API key**, rồi bấm **Lưu**.
   Key được lưu trong `chrome.storage.sync` và đồng bộ theo tài khoản Chrome.
   Key chỉ nằm trong extension, trang CRM không đọc được.
2. Mở trang **Báo giá**. Extension ghi lại danh sách báo giá trên trang đó, gồm cả trạng thái
   đậm/nhạt (`isRead`: chưa đọc/đã đọc). Chuyển trang danh sách thì ghi thêm.
3. Mở từng báo giá để extension ghi lại phần **Bình luận**.
   Lưu ý: CRM tự đánh dấu báo giá là **đã đọc** khi mở.
4. Bấm nút **📊 Đánh giá NVKD** ở góc dưới bên trái:
   - **Báo giá đang mở → 💬 Gợi ý câu hỏi cho NVKD** (bộ câu hỏi nhân viên): Claude đọc luồng bình luận
     rồi soạn một bình luận hỏi NVKD về bước tiếp theo, ví dụ khách phản hồi giá chưa, khi nào lên đơn.
     Claude học văn phong từ chính các bình luận của bạn (tài khoản Nguyễn Trung Toán), ưu tiên những câu
     bạn đã nói với đúng NVKD đó để xưng hô cho đúng. Với báo giá đã quá 12 giờ, gợi ý chỉ là một câu ngắn
     hỏi giá cả đã ok chưa, khách đồng ý chốt chưa.
     **Chèn vào bình luận**: nếu báo giá đã có bình luận, extension bấm **Trả lời** ở luồng mới nhất của báo
     giá đang mở (luồng có nhãn mã màu xanh) rồi điền vào ô trả lời; nếu chưa có thì điền vào ô bình luận mới.
     Extension không tự gửi: bạn xem lại rồi tự bấm gửi.
   - **Bộ câu hỏi nhân viên** nằm trong `BO_CAU_HOI` ở đầu [scripts/bao-gia/panel.js](scripts/bao-gia/panel.js).
     Muốn nạp thêm câu hỏi thì thêm một dòng vào nhóm phù hợp rồi push:
     `luonHoi` (luôn cân nhắc hỏi ở gợi ý bình thường và chào lại – "Em tới công ty khách hàng xem quy mô chưa em?";
     không gộp vào hỏi nhanh hay tình huống đặc biệt),
     `theoGiaiDoan` (theo giai đoạn báo giá), `hoiNhanh` (khi quá 12 giờ),
     `chaoLai` (báo giá Thất bại hoặc im lặng quá 30 ngày – chào lại khách, hỏi khách còn dự án thùng khác không).
     `tinhHuong` (tình huống đặc biệt nhận ra từ nội dung bình luận, ưu tiên hơn các nhóm khác – mỗi mục gồm
     `khi` và `hoi`; vd. NVKD báo khách hẹn đặt sau → hỏi "Kết quả của báo giá này sao rồi?"; bình luận cuối là quản lý đã cho
     giá mà NVKD chưa phản hồi → hỏi lại "Giá cả ok không?"; khách cần/phải có mẫu → "Nếu chưa có mẫu thì
     đàm phán làm mẫu cho khách"; khách đã đặt chỗ khác → "Xin giá khách làm bên kia là bao nhiêu để lần sau
     chào lại").
   - **🔄 Thu thập ngầm & tự phân tích** (bật sẵn, tắt được trong bảng): khi đang mở CRM, extension tự mở lần lượt
     các báo giá trong 60 ngày gần đây trong một khung ẩn để ghi lại bình luận (tối đa 30 báo giá mỗi lượt,
     30 phút một lượt, chỉ 1 tab chạy). Khung ẩn chỉ đọc: chặn lệnh đánh dấu đã đọc và mọi lệnh ghi, nên báo
     giá chưa đọc vẫn in đậm. Sau mỗi lượt, tự soạn gợi ý cho tối đa 10 báo giá cần hỏi lại.
   - Báo giá đã lên đơn hàng Misa được coi là đã chốt (kể cả khi tình trạng báo giá vẫn là Bản thảo).
   - **💤 Cần chào lại khách**: liệt kê các báo giá thuộc chế độ chào lại ở trên.
   - **Báo giá đang mở → 🤖 Đánh giá NVKD**: Claude chấm điểm NVKD qua luồng bình luận của báo giá đó.
   - **⏰ Quá 12 giờ chưa cập nhật**: liệt kê báo giá chưa chốt (khác Duyệt lên đơn, Thành công, Thất bại)
     mà bình luận cuối đã quá 12 giờ. Số lượng hiện ngay trên nút nổi. Với những báo giá này, câu hỏi gợi ý
     tập trung vào việc hỏi giá cả đạt chưa, ví dụ "8 ngày chưa có phản hồi, báo cáo lại nhé chị. Giá cả đạt chưa chị?".

Extension không tự gọi API của CRM. Nó chỉ đọc lại những phản hồi mà trang CRM vốn đã tải về,
nên không cần quyền gì thêm và không làm đổi trạng thái của báo giá.
Nội dung bình luận được gửi tới Claude API (Anthropic) để đánh giá.

## Cài đặt trên mỗi máy (một lần)

1. Mở `chrome://extensions`, bật **Developer mode**.
2. Bấm **Load unpacked** → chọn thư mục `extension/`.
3. Chrome 138 trở lên: bấm **Chi tiết** của extension → bật **Allow User Scripts**.
   Với Chrome 120–137 chỉ cần bật Developer mode.
4. Bấm vào icon extension để xem trạng thái. Nếu thấy commit và danh sách script là xong.

## Thêm hoặc sửa script

Khai báo script trong `scripts/manifest.json`:

```json
{
  "version": "1.0.1",
  "scripts": [
    {
      "id": "duyet-gia",
      "files": ["lib/utils.js", "duyet-gia.js"],
      "matches": ["https://ten-mien-cua-ban.vn/*"],
      "excludeMatches": [],
      "runAt": "document_idle",
      "world": "MAIN",
      "allFrames": false,
      "enabled": true
    }
  ]
}
```

- `files`: các file chạy theo thứ tự trong cùng một scope (đường dẫn tính từ `scripts/`).
- `world`: `MAIN` thì dùng chung biến với trang (đọc được biến JS của trang).
  `USER_SCRIPT` thì chạy tách biệt. Mặc định là `USER_SCRIPT`.
- `runAt`: `document_start` | `document_end` | `document_idle`.

Sau khi push, các máy nhận bản mới trong vòng tối đa `intervalMinutes` (mặc định 1 phút; kiểm tra
bằng ETag nên không tốn giới hạn API của GitHub khi không có commit mới), hoặc ngay lập tức nếu bấm
**Cập nhật ngay** trong popup – nút này cập nhật xong sẽ tự tải lại tab CRM đang mở.

## Cách hoạt động

- Service worker gọi GitHub API để lấy SHA commit mới nhất của nhánh, rồi tải
  `manifest.json` và các file JS theo đúng SHA đó. Đọc theo SHA nên không bị dính cache.
- Code được đăng ký bằng `chrome.userScripts` (API chính thức của Manifest V3 cho script
  từ xa, Tampermonkey cũng dùng API này). Nhờ vậy code chạy được cả trên trang có CSP chặt.
- Bản đã tải được lưu trong `chrome.storage.local`, nên khi mất mạng extension vẫn chạy
  bản gần nhất.
- Cài đặt (repo, nhánh, token...) lưu trong `chrome.storage.sync`, nên tự đồng bộ giữa các
  máy đăng nhập cùng tài khoản Chrome.

## Repo private

Tạo GitHub fine-grained token chỉ có quyền **Contents: Read-only** cho repo này, rồi dán
vào ô Token trong popup. GitHub API không cần token cho phép 60 request/giờ mỗi IP.
Lần kiểm tra không có commit mới (304) không bị tính vào giới hạn này.

## Lưu ý

Extension tải code từ xa nên không đưa lên Chrome Web Store được. Chỉ dùng nội bộ bằng
Load unpacked. Ai có quyền push vào repo thì code của người đó sẽ chạy trên mọi máy đã cài,
nên cần giới hạn quyền ghi repo.
