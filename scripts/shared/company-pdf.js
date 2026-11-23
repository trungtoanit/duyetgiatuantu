// Dùng chung: dựng + in bản PDF "Danh sách công ty" (Google Maps và tab 📍 Công ty Maps trên CRM).
// Sửa định dạng ở ĐÂY → cả 2 nơi đổi giống nhau. Được nạp trước maps.js / panel.js (cùng world USER_SCRIPT) → hàm toàn cục.
// rows: [{ name (tên hiển thị), mst, ind, addr, phone, kcn, erp: { id, code, staffName } | null }]
function dgCompanyPdf({ title, rows, erpHost = 'https://sale.tuantu.com.vn', pre = null }) {
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // +84 274 7303 689 → 0274 7303 689 (gọn hơn, không bị cắt cột)
  const vnPhone = (p) => String(p || '').trim().replace(/^\+?84[\s.-]*/, '0').replace(/\s+/g, ' ');
  const isMobileNo = (p) => {
    let d = String(p || '').replace(/\D/g, '');
    if (d.startsWith('84')) d = `0${d.slice(2)}`;
    return /^0[35789]\d{8}$/.test(d);
  };
  // Tên NVKD rút gọn: ≤ 3 chữ → chữ cuối; dài hơn → 2 chữ cuối
  const nvkdShort = (n) => {
    const w = String(n || '').trim().split(/\s+/).filter(Boolean);
    return w.length <= 3 ? w.slice(-1).join(' ') : w.slice(-2).join(' ');
  };
  if (!rows?.length) {
    pre?.close();
    alert('Không có công ty nào để xuất.');
    return;
  }
  const groups = new Map();
  for (const c of rows) {
    const k = c.kcn || 'Ngoài KCN';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const order = [...groups.entries()].sort((a, b) => (a[0] === 'Ngoài KCN') - (b[0] === 'Ngoài KCN') || b[1].length - a[1].length);
  const nErp = rows.filter((c) => c.erp).length;
  let stt = 0;
  const body = order.map(([k, list2]) => `<tr class="g"><td colspan="8">${k === 'Ngoài KCN' ? '📍' : '🏭'} ${esc(k)} · ${list2.length} công ty</td></tr>${list2.sort((a, b) => a.name.localeCompare(b.name, 'vi')).map((c) => {
    const e = c.erp;
    const nm = c.name.toLocaleUpperCase('vi');
    return `<tr${e ? ' class="erp"' : ''}><td class="c">${++stt}</td><td title="${esc(c.name)}">${e ? `<a href="${erpHost}/khach-hang/view/${e.id}?dgNoPanel=1" target="_blank" rel="noopener"><b>${esc(nm)}</b> ↗</a>` : `<b>${esc(nm)}</b>`}</td><td>${esc(c.mst || '')}</td><td title="${esc(c.ind || '')}">${esc(c.ind || '')}</td><td title="${esc(c.addr || '')}">${esc(c.addr || '')}</td>${e ? '<td colspan="2"><span class="m">– khách ERP (ẩn SĐT)</span></td>' : isMobileNo(c.phone) ? `<td class="mob">${esc(vnPhone(c.phone))}</td><td></td>` : `<td></td><td class="tel">${esc(vnPhone(c.phone))}</td>`}<td title="${e ? esc(`${e.staffName || ''} ${e.code || ''}`) : ''}">${e ? `<b>✅ ${esc(e.staffName ? nvkdShort(e.staffName) : 'Chưa gán NVKD')}</b> <span class="m">${esc(e.code || '')}</span>` : ''}</td></tr>`;
  }).join('')}`).join('');
  const now = new Date();
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${esc(title)} – ${now.toLocaleDateString('vi-VN')}</title><style>
@page{size:A4 landscape;margin:10mm}body{font:11px/1.35 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a;margin:0}
h1{font-size:17px;margin:0 0 2px;color:#1e3a8a}.sub{color:#475569;margin-bottom:8px}
table{width:100%;border-collapse:collapse;table-layout:fixed}th{background:#1e3a8a;color:#fff;text-align:left;padding:5px 6px;font-size:10.5px;white-space:nowrap;overflow:hidden}
td{border-bottom:1px solid #e2e8f0;padding:3px 6px;vertical-align:middle;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
col.c1{width:44px}col.c2{width:27%}col.c3{width:84px}col.c4{width:10%}col.c5{width:auto}col.c6{width:104px}col.c6b{width:112px}td.mob,td.tel{text-overflow:clip;font-variant-numeric:tabular-nums;padding-left:4px;padding-right:4px}col.c7{width:12%}td.mob{color:#15803d;font-weight:800}td.tel{color:#64748b}
tr.g td{background:#fff7ed;color:#9a3412;font-weight:800;padding:4px 6px;border-top:2px solid #fdba74;white-space:nowrap}tr.erp td{background:#f0fdf4}.c{text-align:center;color:#64748b;text-overflow:clip!important;padding-left:2px!important;padding-right:2px!important}a{color:#15803d;text-decoration:none}a:hover{text-decoration:underline}.m{color:#64748b;font-size:10px}
thead{display:table-header-group}tr{page-break-inside:avoid}</style></head><body>
<h1>CÔNG TY CỔ PHẦN BAO BÌ GIẤY TUẤN TÚ – ${esc(title)}</h1>
<div class="sub">Xuất lúc ${now.toLocaleString('vi-VN')} · ${rows.length} công ty · ✅ ${nErp} đã có trong ERP (hiện NVKD phụ trách, ẩn SĐT) · nguồn: Google Maps + masothue.com</div>
<table><colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"><col class="c5"><col class="c6"><col class="c6b"><col class="c7"></colgroup><thead><tr><th>STT</th><th>Tên công ty</th><th>MST</th><th>Ngành</th><th>Địa chỉ</th><th>📱 Di động</th><th>☎ Số bàn</th><th>ERP – NVKD phụ trách</th></tr></thead><tbody>${body}</tbody></table>
</body></html>`;
  const w = pre || window.open('', '_blank');
  if (!w) {
    alert('Trình duyệt chặn cửa sổ in – cho phép pop-up rồi bấm lại.');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  // link tên khách ERP: trang about:blank không tự mở tab mới → bắt bấm, mở bằng cửa sổ in
  w.document.addEventListener('click', (ev) => {
    const a = ev.target.closest?.('a[href]');
    if (!a) return;
    ev.preventDefault();
    const t = w.open(a.href, '_blank', 'noopener');
    if (!t) w.location.assign(a.href);
  });
  // trang trống kế thừa CSP của trang gọi (chặn <script>) → gọi in từ đây
  setTimeout(() => {
    try {
      w.focus();
      w.print();
    } catch {}
  }, 500);
}
