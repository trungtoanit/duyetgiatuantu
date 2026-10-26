#!/usr/bin/env python3
"""Tải ảnh chữ ký NVKD (kv staffSigns – đường dẫn do extension lấy ngầm từ trang Nhân sự) về dạng data URL
rồi đẩy lên Supabase (kv signImgs) để ảnh báo giá chèn được chữ ký (máy chủ ảnh chặn CORS nên trình duyệt không tự tải được).
Chạy: python3 tools/sync_signs.py   (đọc extension/team.json – KHÔNG commit file đó)"""
import base64, json, time, urllib.request
from pathlib import Path

t = json.loads((Path(__file__).resolve().parent.parent / 'extension' / 'team.json').read_text())
base = t['supabaseUrl'].rstrip('/') + '/rest/v1/dg_items'
h = {'apikey': t['supabaseKey'], 'x-team-secret': t['teamSecret'], 'Content-Type': 'application/json'}

def get(ns):
    r = urllib.request.urlopen(urllib.request.Request(f'{base}?ns=eq.{ns}&select=id,data', headers=h)).read()
    return {x['id']: x['data'] for x in json.loads(r)}

rows = []
# Tuấn Tú: staffSigns → signImgs · Đại Dương (tiền tố dd.): dd.staffSigns → dd.signImgs
for pre in ['', 'dd.']:
  staff, imgs = get(pre + 'staffSigns'), get(pre + 'signImgs')
  for name, s in staff.items():
    url = (s or {}).get('sign')
    if not url or imgs.get(name, {}).get('url') == url:
        continue
    b = urllib.request.urlopen(url).read()
    rows.append({'ns': pre + 'signImgs', 'id': name, 'data': {'url': url, 'img': 'data:image/png;base64,' + base64.b64encode(b).decode(), 'at': int(time.time() * 1000)}})
    print('+', pre or 'tt.', name, len(b), 'bytes')
if rows:
    req = urllib.request.Request(base, data=json.dumps(rows).encode(), method='POST', headers={**h, 'Prefer': 'resolution=merge-duplicates'})
    print('upload', urllib.request.urlopen(req).status)
else:
    print('Không có chữ ký mới.')
