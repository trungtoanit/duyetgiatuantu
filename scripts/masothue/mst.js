// Chạy trong world USER_SCRIPT trên masothue.com – "tab tra MST" cho Google Maps (như tab Zalo).
// masothue.com chặn truy vấn không có phiên trình duyệt (Cloudflare) → Maps xếp việc vào kv 'mstJobs', tab này (người dùng tự mở,
// bật bằng đường dẫn có #dgmst) lần lượt mở trang tìm kiếm của masothue, đọc kết quả (tên, MST, địa chỉ) rồi trả về kv.
// Chậm rãi: mỗi việc cách nhau ≥ 15 giây. Gặp trang xác minh của Cloudflare → DỪNG, chờ người dùng tự xác minh (không vượt).
(() => {
  if (window.top !== window || window.__dgMst) return;
  window.__dgMst = true;
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
  const kvMerge = (key, patch) => call({ type: 'kv.merge', key, patch });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const GAP = 15e3;

  if (location.hash === '#dgmst') sessionStorage.setItem('dgMstWorker', '1'); // chỉ tab mở bằng #dgmst mới tra ngầm (theo từng tab)
  if (sessionStorage.getItem('dgMstWorker') !== '1') return; // tab masothue bình thường → không làm gì

  const bar = document.createElement('div');
  bar.setAttribute('style', 'position:fixed;left:12px;bottom:12px;z-index:2147483000;max-width:440px;padding:8px 12px;border-radius:12px;background:#4c1d95;color:#fff;font:700 13px/1.4 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;box-shadow:0 10px 26px rgba(0,0,0,.3)');
  const say = (t) => {
    bar.innerHTML = `🧾 Trợ lý ERP · tab tra MST – để tab này mở<br><span style="font-weight:500">${t}</span> <a href="#" data-off style="color:#fde68a;margin-left:6px">Tắt</a>`;
    if (!bar.isConnected && document.body) document.body.append(bar);
  };
  bar.addEventListener('click', (e) => {
    if (!e.target.closest('[data-off]')) return;
    e.preventDefault();
    sessionStorage.removeItem('dgMstWorker');
    bar.remove();
  });
  const blocked = () => /Just a moment|Attention Required|Cloudflare/i.test(document.title) || !!document.querySelector('#challenge-form, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]');

  function parse() {
    // Trang chi tiết 1 công ty (tìm theo MST → masothue mở thẳng trang công ty): ĐỌC TRANG CHI TIẾT TRƯỚC –
    // trang này còn có danh sách công ty khác (div[data-prefetch]) ở cột bên, đọc nhầm sẽ không ra đúng MST
    const mm0 = (document.querySelector('td[itemprop="taxID"]')?.textContent || '').trim();
    if (mm0) {
      const nm0 = (document.querySelector('table.table-taxinfo thead th, th[itemprop="name"], h1')?.textContent || '').replace(/\s+/g, ' ').trim();
      const ad0 = (document.querySelector('td[itemprop="address"]')?.textContent || '').trim();
      if (nm0) return [{ name: nm0.replace(/^\d[\d-]*\s*-\s*/, ''), mst: mm0, addr: ad0, href: location.href.split('?')[0], info: taxInfo() }];
    }
    const list = [...document.querySelectorAll('div[data-prefetch]')].map((d) => {
      const a = d.querySelector('h3 a');
      const href = a?.getAttribute('href') || '';
      const mst = (href.match(/^\/(\d{10}(?:-\d{3})?)-/) || [])[1] || (d.innerText.match(/Mã số thuế:\s*([\d-]{10,14})/) || [])[1] || '';
      const lines = d.innerText.split('\n').map((x) => x.trim()).filter(Boolean);
      const addr = lines.filter((x) => !/^Mã số thuế|^Người đại diện/i.test(x) && x !== a?.textContent.trim()).pop() || '';
      return { name: (a?.textContent || '').trim(), mst, addr, href: href ? `https://masothue.com${href}` : '' };
    }).filter((r) => r.name && r.mst);
    if (list.length) return list;
    // chỉ 1 kết quả → masothue mở thẳng trang công ty
    const mm = (document.querySelector('td[itemprop="taxID"]')?.textContent || '').trim();
    const nm = (document.querySelector('table.table-taxinfo thead th, th[itemprop="name"], h1')?.textContent || '').trim();
    const ad = (document.querySelector('td[itemprop="address"]')?.textContent || '').trim();
    return mm && nm ? [{ name: nm.replace(/^\d[\d-]*\s*-\s*/, ''), mst: mm, addr: ad, href: location.href.split('?')[0], info: taxInfo() }] : [];
  }
  // Toàn bộ bảng thông tin trên trang công ty: [[nhãn, giá trị]] theo đúng thứ tự (Mã số thuế, Địa chỉ Thuế, Địa chỉ, Tình trạng,
  // Người đại diện, Điện thoại, Ngày hoạt động, Quản lý bởi, Loại hình DN, Ngành nghề chính…)
  function taxInfo() {
    const out = [];
    for (const tr of document.querySelectorAll('table.table-taxinfo tbody tr')) {
      const td = tr.querySelectorAll('td');
      if (td.length < 2) continue;
      const k = td[0].innerText.replace(/\s+/g, ' ').trim();
      const v = td[1].innerText.replace(/\s+/g, ' ').replace(/\s*(Ẩn thông tin|Copy|Sao chép)\s*$/i, '').trim();
      if (k && v && out.length < 20) out.push([k.slice(0, 40), v.slice(0, 300)]);
    }
    return out;
  }

  async function run() {
    // masothue có thể chuyển thẳng sang trang công ty (mất ?dgjob) → nhớ việc đang làm trong localStorage
    const job = new URLSearchParams(location.search).get('dgjob') || (Date.now() - (Number(sessionStorage.getItem('dgMstJobAt')) || 0) < 60e3 ? sessionStorage.getItem('dgMstJob') : '');
    sessionStorage.removeItem('dgMstJob');
    if (job) {
      if (blocked()) {
        await kvMerge('mstJobs', { [job]: { status: 'blocked', at: Date.now() } });
        say('⚠️ masothue yêu cầu xác minh (Cloudflare) – hãy tự xác minh trên trang này, xong sẽ tự chạy tiếp.');
        for (;;) {
          await sleep(5000);
          if (!blocked()) break;
        }
        location.reload();
        return;
      }
      await sleep(800);
      const list = parse();
      const jobs = await kvGet('mstJobs');
      // tra bằng MST mà masothue ra trang danh sách → mở trang công ty đúng MST đó để đọc đủ bảng thông tin (1 lần)
      const q = String(jobs[job]?.q || '');
      const hit = /^\d{10}(-\d{3})?$/.test(q) && !list[0]?.info && list.find((x) => String(x.mst).replace(/\D/g, '') === q.replace(/\D/g, '') && x.href);
      if (hit && sessionStorage.getItem('dgMstHop') !== job) {
        sessionStorage.setItem('dgMstHop', job);
        sessionStorage.setItem('dgMstJob', job);
        sessionStorage.setItem('dgMstJobAt', String(Date.now()));
        location.href = hit.href;
        return;
      }
      // tra bằng MST: chỉ giữ kết quả ĐÚNG MST đó (trang khác / công ty khác → coi như không có), tránh lưu nhầm thông tin
      const isMst = /^\d{10}(-\d{3})?$/.test(q);
      const out = isMst ? list.filter((x) => String(x.mst).replace(/\D/g, '') === q.replace(/\D/g, '')) : list;
      await kvMerge('mstJobs', { [job]: { ...(jobs[job] || {}), status: 'done', list: out, doneAt: Date.now() } });
      say(`✅ Đã tra: ${jobs[job]?.q || ''} → ${out.length} kết quả`);
      localStorage.setItem('dgMstLast', String(Date.now()));
    }
    const TAB = sessionStorage.getItem('dgMstTab') || Math.random().toString(36).slice(2);
    sessionStorage.setItem('dgMstTab', TAB);
    for (;;) {
      // chỉ 1 tab masothue nhận việc (khoá kv mstLock, 20 giây) – tab khác đứng chờ
      const lk = await kvGet('mstLock').catch(() => ({}));
      if (lk?.tab && lk.tab !== TAB && Date.now() - (lk.at || 0) < 20e3) {
        say('💤 Tab masothue khác đang tra MST – tab này đứng chờ.');
        await sleep(5000);
        continue;
      }
      await call({ type: 'kv.set', key: 'mstLock', value: { tab: TAB, at: Date.now() } }).catch(() => {});
      await call({ type: 'kv.set', key: 'mstAlive', value: { at: Date.now() } }).catch(() => {});
      const jobs = await kvGet('mstJobs').catch(() => ({}));
      const next = Object.entries(jobs).filter(([, j]) => j?.status === 'pending').sort((a, b) => a[1].at - b[1].at)[0];
      if (next) {
        const wait = GAP - (Date.now() - (Number(localStorage.getItem('dgMstLast')) || 0));
        if (wait > 0) {
          say(`⏳ Chờ ${Math.ceil(wait / 1000)} giây rồi tra: ${next[1].q}`);
          await sleep(wait);
        }
        await kvMerge('mstJobs', { [next[0]]: { ...next[1], status: 'working', startAt: Date.now() } });
        sessionStorage.setItem('dgMstJob', next[0]);
        sessionStorage.setItem('dgMstJobAt', String(Date.now()));
        location.href = `https://masothue.com/Search/?q=${encodeURIComponent(next[1].q)}&type=auto&force-search=1&dgjob=${encodeURIComponent(next[0])}`;
        return;
      }
      say('💤 Chờ việc tra MST từ Google Maps…');
      await sleep(3000);
    }
  }
  const start = () => run().catch((e) => say(`⚠️ ${e.message || e}`));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
