// Dùng chung: dựng + in bản PDF "Danh sách công ty" (Google Maps và tab 📍 Công ty Maps trên CRM).
// Sửa định dạng ở ĐÂY → cả 2 nơi đổi giống nhau. Được nạp trước maps.js / panel.js (cùng world USER_SCRIPT) → hàm toàn cục.
// rows: [{ name (tên hiển thị), mst, ind, addr, phone, kcn, erp: { id, code, staffName } | null }]
// group: false → không gom theo KCN, giữ đúng thứ tự rows (vd. đang sắp Gần → xa / Xưởng lớn → nhỏ)
function dgCompanyPdf({ title, rows, erpHost = 'https://sale.tuantu.com.vn', pre = null, group = true }) {
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
  const order = group ? [...groups.entries()].sort((a, b) => (a[0] === 'Ngoài KCN') - (b[0] === 'Ngoài KCN') || b[1].length - a[1].length) : [['', rows]];
  const nErp = rows.filter((c) => c.erp).length;
  let stt = 0;
  // SĐT di động → link mở Zalo (https://zalo.me/0xxxxxxxxx: trên máy có app Zalo thì mở app, không thì Zalo web) – bấm được cả trong file PDF
  // app Zalo trên máy (PC / Mac / điện thoại): zalo://conversation?phone=84…
  const zaloApp = (p) => {
    let d = String(p || '').replace(/\D/g, '');
    if (d.startsWith('0')) d = `84${d.slice(1)}`;
    return `zalo://conversation?phone=${d}`;
  };
  // “Khu công nghiệp …” → “KCN …”, “Cụm công nghiệp …” → “CCN …” (cho gọn cột)
  const kcnShort = (t) => String(t || '').replace(/^\s*khu\s+c[oô]ng\s+nghi[eệ]p\s*/i, 'KCN ').replace(/^\s*c[uụ]m\s+c[oô]ng\s+nghi[eệ]p\s*/i, 'CCN ').replace(/^\s*c[uụ]m\s+cn\s*/i, 'CCN ').replace(/^\s*khu\s+cn\s*/i, 'KCN ');
  const zaloOf = (p) => {
    let d = String(p || '').replace(/\D/g, '');
    if (d.startsWith('84')) d = `0${d.slice(2)}`;
    return `https://zalo.me/${d}`;
  };
  const body = order.map(([k, list2]) => `${group ? `<tr class="g"><td colspan="9">${k === 'Ngoài KCN' ? '📍' : '🏭'} ${esc(k === 'Ngoài KCN' ? k : kcnShort(k))} · ${list2.length} công ty</td></tr>` : ''}${(group ? list2.sort((a, b) => a.name.localeCompare(b.name, 'vi')) : list2).map((c) => {
    const e = c.erp;
    const nm = c.name.toLocaleUpperCase('vi');
    return `<tr${e ? ' class="erp"' : ''}><td class="c">${++stt}</td><td title="${esc(c.name)}">${e ? `<a href="${erpHost}/khach-hang/view/${e.id}?dgNoPanel=1" target="_blank" rel="noopener"><b>${esc(nm)}</b> ↗</a>` : `<b>${esc(nm)}</b>`}</td><td>${esc(c.mst || '')}</td><td title="${esc(c.ind || '')}">${esc(c.ind || '')}</td><td title="${esc(c.kcn || c.addr || '')}">${c.kcn ? `<span style="color:#9a3412;font-weight:700">${esc(kcnShort(c.kcn))}</span>` : esc(c.addr || '')}</td><td class="km">${c.km ? `${Number(c.km).toFixed(1)} km` : ''}</td>${e ? '<td colspan="2"><span class="m">– khách ERP (ẩn SĐT)</span></td>' : isMobileNo(c.phone) ? `<td class="mob"><a href="${zaloApp(c.phone)}" data-app="${zaloApp(c.phone)}" title="Mở chat trong app Zalo trên máy" style="color:inherit">${esc(vnPhone(c.phone))} <span style="color:#0068ff;font-size:9.5px;font-weight:800">Zalo</span></a></td><td></td>` : `<td></td><td class="tel">${esc(vnPhone(c.phone))}</td>`}<td title="${e ? esc(`${e.staffName || ''} ${e.code || ''}`) : ''}">${e ? `<b>✅ ${esc(e.staffName ? nvkdShort(e.staffName) : 'Chưa gán NVKD')}</b> <span class="m">${esc(e.code || '')}</span>` : ''}</td></tr>`;
  }).join('')}`).join('');
  const now = new Date();
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${esc(title)} – ${now.toLocaleDateString('vi-VN')}</title><style>
@page{size:A4 landscape;margin:10mm}body{font:11px/1.35 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a;margin:0}
h1{font-size:17px;margin:0 0 2px;color:#1e3a8a}.sub{color:#475569;margin-bottom:8px}
table{width:100%;border-collapse:collapse;table-layout:fixed}th{background:#1e3a8a;color:#fff;text-align:left;padding:5px 6px;font-size:10.5px;white-space:nowrap;overflow:hidden}
td{border-bottom:1px solid #e2e8f0;padding:3px 6px;vertical-align:middle;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
col.c1{width:44px}col.c2{width:24%}col.c3{width:84px}col.c4{width:9%}col.c5{width:auto;min-width:150px}col.c5k{width:62px}td.km{text-align:right;color:#0f766e;font-weight:800;text-overflow:clip;font-variant-numeric:tabular-nums}col.c6{width:104px}col.c6b{width:112px}td.mob,td.tel{text-overflow:clip;font-variant-numeric:tabular-nums;padding-left:4px;padding-right:4px}col.c7{width:11%}td.mob{color:#15803d;font-weight:800}td.tel{color:#64748b}
tr.g td{background:#fff7ed;color:#9a3412;font-weight:800;padding:4px 6px;border-top:2px solid #fdba74;white-space:nowrap}tr.erp td{background:#f0fdf4}.c{text-align:center;color:#64748b;text-overflow:clip!important;padding-left:2px!important;padding-right:2px!important}a{color:#15803d;text-decoration:none}a:hover{text-decoration:underline}.m{color:#64748b;font-size:10px}
thead{display:table-header-group}tr{page-break-inside:avoid}</style></head><body>
<h1>CÔNG TY CỔ PHẦN BAO BÌ GIẤY TUẤN TÚ – ${esc(title)}</h1>
<div class="sub">Xuất lúc ${now.toLocaleString('vi-VN')} · ${rows.length} công ty · ✅ ${nErp} đã có trong ERP (hiện NVKD phụ trách, ẩn SĐT) · nguồn: Google Maps + masothue.com</div>
<table><colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"><col class="c5"><col class="c5k"><col class="c6"><col class="c6b"><col class="c7"></colgroup><thead><tr><th>STT</th><th>Tên công ty</th><th>MST</th><th>Ngành</th><th>KCN / Địa chỉ</th><th title="Đường bộ thực tế từ xưởng Tuấn Tú">🛣 Km</th><th>📱 Di động</th><th>☎ Số bàn</th><th>ERP – NVKD phụ trách</th></tr></thead><tbody>${body}</tbody></table>
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
    if (a.dataset.app) {
      // trên trang in: mở thẳng app Zalo (zalo://…) ngay trong trang. File PDF (Chrome lưu) giữ nguyên link zalo:// → bấm mở app Zalo (app Zalo PC nhận zalo://conversation?phone=…)
      const f = w.document.createElement('iframe');
      f.style.display = 'none';
      f.src = a.dataset.app;
      w.document.body.append(f);
      setTimeout(() => f.remove(), 3000);
      return;
    }
    // SĐT di động → mở app Zalo (lược đồ zalo://, trang in không bị chuyển đi)
    if (/^zalo:/i.test(a.getAttribute('href') || '')) {
      w.location.href = a.getAttribute('href');
      return;
    }
    // không dùng 'noopener' (khi đó window.open luôn trả null → tưởng bị chặn, cửa sổ in bị chuyển trang)
    const t = w.open(a.href, '_blank');
    if (t) {
      try { t.opener = null; } catch {}
    } else w.location.assign(a.href);
  });
  // trang trống kế thừa CSP của trang gọi (chặn <script>) → gọi in từ đây
  setTimeout(() => {
    try {
      w.focus();
      w.print();
    } catch {}
  }, 500);
}
