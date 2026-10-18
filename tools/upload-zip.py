#!/usr/bin/env python3
# Đưa file zip extension lên máy chủ đồng bộ (Supabase, bảo vệ bằng mật khẩu nhóm) để quản trị
# tải về từ tab ⚙️ Cài đặt trong bảng Trợ lý ERP và gửi cho nhân viên. KHÔNG đưa lên GitHub (có mật khẩu nhóm).
import base64, json, os, sys, time, urllib.request

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
team = json.load(open(os.path.join(root, 'extension', 'team.json')))
path = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/Desktop/DuyetGia-extension.zip')
raw = open(path, 'rb').read()
ver = json.load(open(os.path.join(root, 'scripts', 'manifest.json'))).get('version', '')
row = [{'ns': 'files', 'id': 'extension-zip', 'data': {
    'name': 'DuyetGia-extension.zip', 'size': len(raw), 'b64': base64.b64encode(raw).decode(),
    'version': ver, 'at': int(time.time() * 1000)}}]
req = urllib.request.Request(
    team['supabaseUrl'].rstrip('/') + '/rest/v1/dg_items?on_conflict=ns,id', data=json.dumps(row).encode(), method='POST',
    headers={'apikey': team['supabaseKey'], 'x-team-secret': team['teamSecret'], 'Content-Type': 'application/json',
             'Prefer': 'resolution=merge-duplicates,return=minimal'})
urllib.request.urlopen(req)
print(f'Đã đưa {os.path.basename(path)} ({len(raw)//1024} KB) lên máy chủ')
