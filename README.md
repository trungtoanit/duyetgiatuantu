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
     **📨 Gửi bình luận**: bấm là gửi luôn, không hỏi lại. Nếu báo giá đã có bình luận, extension bấm **Trả lời**
     ở luồng mới nhất của báo giá đang mở (luồng có nhãn mã màu xanh), điền nội dung và bấm gửi; nếu chưa có
     thì gửi vào ô bình luận mới. Có thể sửa nội dung gợi ý trước khi gửi.
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
   - NVKD không theo dõi nằm trong `EXCLUDED_STAFF` ở đầu panel.js (hiện: Trần Đình Hùng, Nguyễn Trí Thức,
     Nguyễn Thăng Khôi) – báo giá của họ không vào danh sách hỏi lại, không thu thập ngầm, không tự gợi ý.
   - Báo giá đã lên đơn hàng Misa được coi là đã chốt (kể cả khi tình trạng báo giá vẫn là Bản thảo).
   - **📚 Bộ câu hỏi tự học** (cuối bảng): mỗi 12 giờ, khi có từ 5 bình luận mới của bạn, extension nhờ Claude đọc
     các bình luận thật bạn gửi NVKD (kèm câu NVKD bạn đang trả lời), rút ra câu hỏi / tình huống lặp lại được mà
     `BO_CAU_HOI` chưa có, giữ đúng cách nói của bạn, rồi nạp vào bộ câu hỏi dùng khi soạn gợi ý. Dữ liệu này đồng bộ
     giữa các máy (không sửa code). Bấm **Học ngay** để chạy tức thì; câu không hợp thì **Xoá** – câu đã xoá không bị đề xuất lại.
   - **💤 Cần chào lại khách**: liệt kê các báo giá thuộc chế độ chào lại ở trên.
   - **Báo giá đang mở → 🤖 Đánh giá NVKD**: Claude chấm điểm NVKD qua luồng bình luận của báo giá đó.
   - **⏰ Quá 12 giờ chưa cập nhật**: liệt kê báo giá chưa chốt (khác Duyệt lên đơn, Thành công, Thất bại)
     mà bình luận cuối đã quá 12 giờ. Số lượng hiện ngay trên nút nổi. Với những báo giá này, câu hỏi gợi ý
     tập trung vào việc hỏi giá cả đạt chưa, ví dụ "8 ngày chưa có phản hồi, báo cáo lại nhé chị. Giá cả đạt chưa chị?".

Extension không tự gọi API của CRM. Nó chỉ đọc lại những phản hồi mà trang CRM vốn đã tải về,
nên không cần quyền gì thêm và không làm đổi trạng thái của báo giá.
Nội dung bình luận được gửi tới Claude API (Anthropic) để đánh giá.

### 🔥 Có thể chốt liền (AI)

Ô cam ở đầu bảng 📊: bấm **🔥 AI chọn đơn chốt được liền** → Claude đọc 40 báo giá khả thi điểm cao nhất
(thông tin + 8 bình luận gần nhất + lịch sử mua hàng), chọn tối đa 10 báo giá chốt được trong vài ngày tới, mỗi đơn có
% khả năng, lý do (tín hiệu trong bình luận) và việc cần làm ngay. Bấm một dòng để mở báo giá. Kết quả lưu trong
kho dữ liệu (`aiHot`, đồng bộ) – không tự chạy lại, bấm **🔄 Phân tích lại** khi cần (mỗi lần 1 lượt gọi Claude).

### ⬇️ Xuất Excel

Nút **⬇️ Xuất Excel** cạnh nút xếp của bảng "Báo giá khả thi & chưa đọc": tải đúng danh sách đang hiện
(theo bộ lọc, ô tìm kiếm, cách xếp) ra file `.xlsx` – mã BG, mã/tên khách, nhãn, tên cơ hội, NVKD, tình trạng,
đã đọc, bình luận cuối, số tiền, Flexo % / giấy tấm % / Offset %, điểm + lý do điểm, link báo giá.

### 💬 Bình luận mới nhất

Đầu bảng 📊 (bên phải) hiện 8 thông báo bình luận mới nhất từ chuông của CRM. Thông báo chưa đọc (theo CRM)
in đậm, có chấm xanh. Bấm vào để mở đúng báo giá. Danh sách thông báo kèm trạng thái đã đọc / chưa đọc được
lưu vào kho dữ liệu (`notifs`, đồng bộ Supabase), tách theo từng tài khoản CRM.
Bấm một dòng: mở báo giá ở tab mới và đánh dấu đã đọc (giữ qua các lần tải chuông sau).
Đồng bộ "đã đọc" lên CRM: extension không đoán API mà tự học – bấm 1 thông báo trong chuông CRM một lần,
hook ghi lại lệnh "đánh dấu đã đọc" mà CRM gửi (mẫu lưu ở `localStorage.dgNotifReadTpl`), rồi gửi lại lệnh đó
cho mỗi bình luận bạn bấm trong bảng (kể cả các dòng đã bấm trước đó).

### 🔁 Bàn giao khách hàng

Khi chuông thông báo của CRM có "A đã bàn giao khách hàng X cho nhân viên B" (trong 14 ngày gần nhất),
bảng 📊 hiện mục **🔁 Bàn giao khách hàng** và nút nổi có thêm số 🔁. Extension soạn sẵn một bình luận **mới**
(không trả lời luồng cũ): "Bàn giao khách hàng X từ nhân viên <NVKD cũ> qua nhân viên B". NVKD cũ là người phụ trách
báo giá gần nhất của khách X khác B. Bình luận được đăng vào báo giá gần nhất của khách X: bấm **Mở BGxxx để gửi**,
xem/sửa nội dung rồi bấm **📨 Gửi bình luận mới**. Không tự gửi. **Bỏ qua** để ẩn thông báo đó.

## Đồng bộ giữa các máy (Supabase)

1. Tạo project trên supabase.com, mở **SQL Editor**, chạy [supabase/setup.sql](supabase/setup.sql).
   Dòng kết quả cuối là **mật khẩu nhóm** (sinh ngẫu nhiên).
2. **Project Settings → API**: lấy Project URL và anon public key.
3. Trên mỗi máy: popup → Cài đặt → nhập Supabase URL, anon key, mật khẩu nhóm → Lưu, rồi bấm **Đồng bộ ngay**.

Không ghi các khoá này vào git (repo đang public).

**Máy khác chỉ cần cài extension:** thông tin đồng bộ nằm trong `extension/team.json` (đã bị `.gitignore`).
Chạy `tools/dong-goi.command` để tạo `DuyetGia-extension.zip` trên Desktop, gửi riêng cho máy khác →
giải nén → `chrome://extensions` → **Load unpacked**. Anthropic key/model: trên 1 máy, nhập trong Cài đặt,
tick **Dùng chung cho cả nhóm** → các máy khác tự dùng. Không chia sẻ file zip công khai (có mật khẩu nhóm).

**📦 Thu thập toàn bộ** (popup): đọc tất cả trang danh sách + bình luận mọi báo giá, chạy liên tục
50 báo giá/lượt tới khi xong; các máy chia nhau nhờ dữ liệu "đã thu thập" được đồng bộ.

Nhãn trên danh sách (bấm nhãn trên tiêu đề để lọc, bộ lọc giữ lại sau F5): 💲 Khách cho giá, 💸 Giá cao, 🧾 Xin công nợ,
🚫 Chưa cọc, ⚠️ Chưa cho giá, 📈 Đang bán X% (Offset – đọc từ bảng chiết giá Ctrl+Shift+G, đỏ khi dưới 30%).

🛒 Lịch sử mua hàng của khách: tự đọc trang khách hàng → đơn hàng khi mở báo giá và khi thu thập ngầm; đưa vào
đánh giá NVKD và gợi ý của Claude.

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
qua trang commits.atom của GitHub nên không tốn giới hạn API), hoặc ngay lập tức nếu bấm
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
Repo public kiểm tra qua trang commits.atom nên không bị giới hạn này; repo private (có token) mới dùng API.

## Lưu ý

Extension tải code từ xa nên không đưa lên Chrome Web Store được. Chỉ dùng nội bộ bằng
Load unpacked. Ai có quyền push vào repo thì code của người đó sẽ chạy trên mọi máy đã cài,
nên cần giới hạn quyền ghi repo.
