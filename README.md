# Duyệt giá Tuấn Tú

Extension Chrome dạng "loader": chỉ cài **một lần**, còn code thật nằm trong thư mục
`scripts/` trên GitHub. Mỗi khi push code mới, mọi máy đã cài sẽ tự tải về và chạy bản mới,
không cần cài lại hay bấm reload extension.

```
extension/   # cài vào Chrome (Load unpacked) – hiếm khi phải sửa
scripts/     # code chạy trên trang web – sửa và push thoải mái
  manifest.json
  lib/utils.js
  example.js
```

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

Sau khi push, các máy nhận bản mới trong vòng tối đa `intervalMinutes` (mặc định 5 phút),
hoặc ngay lập tức nếu bấm **Cập nhật ngay** trong popup. Tab đang mở cần tải lại thì script
mới chạy.

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
Với chu kỳ 5 phút thì vẫn đủ.

## Lưu ý

Extension tải code từ xa nên không đưa lên Chrome Web Store được. Chỉ dùng nội bộ bằng
Load unpacked. Ai có quyền push vào repo thì code của người đó sẽ chạy trên mọi máy đã cài,
nên cần giới hạn quyền ghi repo.
