// Chạy trong world USER_SCRIPT trên trang kết quả Google (google.com/search).
// Chỉ hoạt động khi tab 📍 Công ty Maps (CRM) vừa bấm “🧾 Chuẩn hoá MST” → mở Google tìm (kv mstPick, ≤ 15 phút):
// mỗi kết quả có MST (10 số / 10 số-3 số) hiện nút “📥 Lấy MST này”; bấm → ghi kv mstPick { status: 'done', mst, name }
// → tab CRM nhận, lưu MST cho công ty đó lên cloud và lấy tên chuẩn từ masothue. Không bấm / gửi gì trên Google.
(() => {
  if (window.top !== window || window.__dgMstPick) return;
  window.__dgMstPick = true;
  const call = (msg) =>
    new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return reject(new Error('no runtime'));
      chrome.runtime.sendMessage(msg, (r) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else if (r?.error) reject(new Error(r.error));
        else resolve(r?.result);
      });
    });
  const kvGet = async (key) => (await call({ type: 'kv.get', key })) || {};
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const MST_RE = /(?<![\d-])(\d{10}(?:-\d{3})?)(?![\d])/;
  let job = null;

  function nameOf(text, title) {
    const m = text.match(/((?:CÔNG TY|CHI NHÁNH|DOANH NGHIỆP|HỢP TÁC XÃ|CTY)[^.;:|•]{4,140}?)(?=\s*(?:\.|;|\s-\s|Mã số thuế|MST|\(|$))/i);
    if (m) return m[1].trim();
    return String(title || '').replace(MST_RE, '').replace(/^[\s\-–:|]+|[\s\-–:|]+$/g, '').replace(/\s*[-–|]\s*Mã số thuế.*$/i, '').trim();
  }
  function scan() {
    if (!job) return;
    for (const h3 of document.querySelectorAll('#search h3, #rso h3')) {
      const box = h3.closest('div[data-hveid], div.g, div.MjjYud') || h3.parentElement?.parentElement;
      if (!box || box.dataset.dgMst) continue;
      const link = h3.closest('a')?.href || '';
      const txt = `${h3.innerText} ${box.innerText}`;
      const mst = (decodeURIComponent(link).match(/masothue\.com\/(\d{10}(?:-\d{3})?)/) || txt.match(MST_RE) || [])[1];
      box.dataset.dgMst = mst || '-';
      if (!mst) continue;
      const name = nameOf(box.innerText, h3.innerText);
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.mst = mst;
      b.dataset.name = name;
      b.setAttribute('style', 'margin:4px 0 6px;cursor:pointer;border:0;border-radius:8px;padding:5px 12px;font:700 13px -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#fff;background:linear-gradient(90deg,#7c3aed,#6d28d9);box-shadow:0 3px 10px rgba(109,40,217,.35)');
      b.textContent = `📥 Lấy MST ${mst} cho “${job.name}”`;
      b.title = name ? `Tên trên kết quả: ${name}` : '';
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        b.disabled = true;
        b.textContent = '⏳ Đang lưu…';
        try {
          await call({ type: 'kv.set', key: 'mstPick', value: { ...job, status: 'done', mst, pickName: name, doneAt: Date.now() } });
          b.textContent = `✅ Đã gửi MST ${mst} về tab Công ty Maps – có thể đóng tab này`;
          b.style.background = '#16a34a';
          job = null;
          bar();
        } catch (err) {
          b.disabled = false;
          b.textContent = `⚠️ ${err.message || err} – bấm lại`;
        }
      });
      (h3.closest('a') || h3).insertAdjacentElement('afterend', b);
    }
  }
  function bar() {
    let el = document.getElementById('dg-mst-bar');
    if (!job) return el?.remove();
    if (!el) {
      el = document.createElement('div');
      el.id = 'dg-mst-bar';
      el.setAttribute('style', 'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:2147483000;max-width:min(720px,94vw);padding:8px 14px;border-radius:12px;background:#4c1d95;color:#fff;font:700 13px/1.4 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;box-shadow:0 10px 26px rgba(0,0,0,.3)');
      document.body.append(el);
    }
    el.innerHTML = `🧾 Trợ lý ERP – đang tìm MST cho: <u>${esc(job.name)}</u><br><span style="font-weight:500">Bấm “📥 Lấy MST…” ở kết quả đúng công ty.</span>`;
  }
  async function tick() {
    const j = await kvGet('mstPick').catch(() => null);
    job = j && j.status === 'pending' && Date.now() - (j.at || 0) < 15 * 60e3 ? j : null;
    bar();
    scan();
  }
  tick();
  setInterval(tick, 2000);
})();
