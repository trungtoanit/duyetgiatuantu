#!/bin/bash
# Đóng gói extension (kèm team.json – thông tin đồng bộ của nhóm) thành file zip trên Desktop
# để gửi cho máy khác. Máy khác: giải nén → chrome://extensions → Load unpacked → chọn thư mục đã giải nén.
# KHÔNG đưa file zip này lên mạng công khai: bên trong có mật khẩu nhóm.
set -e
cd "$(dirname "$0")/.."
OUT="$HOME/Desktop/DuyetGia-extension.zip"
[ -f extension/team.json ] || { echo "Thiếu extension/team.json"; exit 1; }
rm -f "$OUT"
( cd extension && zip -qr "$OUT" . -x '.DS_Store' )
echo "Đã tạo: $OUT"
open -R "$OUT"
