// Chạy trong world USER_SCRIPT (tách biệt với JS của trang).
// Nhận dữ liệu từ hook.js, lưu vào extension, hiển thị bảng đánh giá NVKD
// và nhờ Claude nhận xét dựa trên phần bình luận của báo giá.
(() => {
  if (window.__dgPanel) return;
  window.__dgPanel = true;

  // ---------- Kết nối với background của extension ----------
  const call = (msg) =>
    new Promise((resolve, reject) =>
      chrome.runtime.sendMessage(msg, (r) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else if (r?.error) reject(new Error(r.error));
        else resolve(r?.result);
      }),
    );
  const kvGet = async (key) => (await call({ type: 'kv.get', key })) || {};
  const kvMerge = (key, patch) => call({ type: 'kv.merge', key, patch });

  // ---------- Tiện ích ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtTime = (sec) =>
    sec
      ? new Date(sec * 1000).toLocaleString('vi-VN', {
          timeZone: 'Asia/Ho_Chi_Minh',
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
  const money = (n) => (n ? `${Number(n).toLocaleString('vi-VN')}đ` : '');
  const currentQuoteId = () => Number(location.pathname.match(/\/co-hoi\/update\/(\d+)/)?.[1]) || null;
  const definedOnly = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

  function mergeThreads(oldT = [], newT = []) {
    const m = new Map(oldT.map((t) => [t.id, t]));
    for (const t of newT) m.set(t.id, t);
    return [...m.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  // NVKD phụ trách: lấy từ báo giá, nếu thiếu thì lấy người tạo bình luận đầu tiên
  const staffOf = (q, c) => q?.staff?.name || c?.threads?.[0]?.staff?.name || '';

  // ---------- Ghi nhận dữ liệu từ hook.js ----------
  let chain = Promise.resolve();
  document.addEventListener('dg:data', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch {
      return;
    }
    chain = chain.then(() => save(msg)).catch((err) => console.warn('[DG]', err));
  });

  async function save({ kind, data }) {
    if (kind === 'quotes') {
      const patch = {};
      for (const q of data) patch[q.id] = definedOnly(q);
      await kvMerge('quotes', patch);
    } else if (kind === 'quote') {
      const cur = await kvGet('quotes');
      await kvMerge('quotes', { [data.id]: { ...cur[data.id], ...definedOnly(data) } });
    } else if (kind === 'comments') {
      const cur = await kvGet('comments');
      const patch = {};
      for (const c of data) {
        patch[c.id] = { id: c.id, code: c.code, threads: mergeThreads(cur[c.id]?.threads, c.threads) };
      }
      await kvMerge('comments', patch);
    }
    if (isOpen()) render();
  }

  // ---------- Claude ----------
  const SYSTEM = `Bạn là trưởng phòng kinh doanh của Tuấn Tú, công ty sản xuất bao bì giấy carton (thùng 3 lớp, 5 lớp, offset, flexo...).
Bạn đọc phần bình luận nội bộ trong báo giá trên CRM – nơi nhân viên kinh doanh (NVKD) trao đổi với cấp trên/bộ phận tính giá – và đánh giá NVKD phụ trách.

Tiêu chí (chấm 1–5 mỗi tiêu chí):
1. Thông tin xin giá đầy đủ: số lượng, quy cách, số lớp/định lượng, in hay không, địa chỉ giao, VAT/hình thức xuất hóa đơn, thời hạn.
2. Tốc độ phản hồi và bám đuổi (dựa vào mốc thời gian giữa các bình luận).
3. Hiểu khách hàng, phát hiện sớm yếu tố ảnh hưởng giá (VAT 0% khu chế xuất, vận chuyển, mẫu của khách...).
4. Giao tiếp rõ ràng, chuyên nghiệp.
5. Hướng tới chốt đơn: có bước tiếp theo, cập nhật tình trạng báo giá.

Yêu cầu:
- Chỉ dựa trên dữ liệu được cung cấp; thiếu dữ liệu thì nói rõ là thiếu, không suy diễn.
- Dòng đầu tiên đúng định dạng: "ĐIỂM: x/10".
- Sau đó: bảng điểm 5 tiêu chí (mỗi dòng "Tên tiêu chí: x/5 – lý do ngắn"), "Điểm mạnh", "Cần cải thiện", "Gợi ý hành động" (cụ thể, làm được ngay).
- Viết tiếng Việt, ngắn gọn, văn bản thuần (không dùng bảng markdown).`;

  function threadText(q, c) {
    const lines = [`Báo giá ${q?.code || c?.code || ''} – "${q?.name || ''}"`];
    if (q) {
      lines.push(
        `Khách hàng: ${q.customer?.name || '?'} | Số tiền: ${money(q.amount) || '?'} | Tình trạng báo giá: ${q.quoteStatus || '?'} | Tạo lúc: ${fmtTime(q.createdAt)}`,
      );
    }
    lines.push(`NVKD phụ trách: ${staffOf(q, c) || '?'}`, 'Bình luận (theo thời gian):');
    const walk = (t, depth) => {
      const file = t.file ? ' [có ảnh/file đính kèm]' : '';
      lines.push(`${'  '.repeat(depth)}${depth ? '↳ ' : '- '}[${fmtTime(t.createdAt)}] ${t.staff?.name || '?'}: ${t.text.trim()}${file}`);
      [...(t.children || [])].sort((a, b) => a.createdAt - b.createdAt).forEach((ch) => walk(ch, depth + 1));
    };
    (c?.threads || []).forEach((t) => walk(t, 0));
    if (!c?.threads?.length) lines.push('(chưa có bình luận nào được ghi lại)');
    return lines.join('\n');
  }

  const parseScore = (text) => {
    const m = text.match(/ĐIỂM[^0-9]*(\d+(?:[.,]\d+)?)\s*\/\s*10/i);
    return m ? Number(m[1].replace(',', '.')) : null;
  };

  async function runEval(evalKey, prompt, meta) {
    setBusy(evalKey, true);
    try {
      const text = await call({ type: 'claude', system: SYSTEM, prompt });
      await kvMerge('evals', { [evalKey]: { ...meta, text, score: parseScore(text), at: Date.now() } });
      state.shown = evalKey;
    } catch (e) {
      state.error = e.message;
    } finally {
      setBusy(evalKey, false);
      render();
    }
  }

  async function evaluateQuote(id) {
    const [quotes, comments] = await Promise.all([kvGet('quotes'), kvGet('comments')]);
    const q = quotes[id];
    const c = comments[id];
    const staff = staffOf(q, c);
    const prompt = `Đánh giá NVKD "${staff || 'phụ trách'}" qua báo giá sau.\n\n${threadText(q, c)}`;
    await runEval(`q:${id}`, prompt, { staff, code: q?.code || c?.code });
  }

  async function evaluateStaff(name) {
    const [quotes, comments] = await Promise.all([kvGet('quotes'), kvGet('comments')]);
    const mine = Object.values(quotes).filter((q) => staffOf(q, comments[q.id]) === name);
    const withComments = mine
      .filter((q) => comments[q.id]?.threads?.length)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30);
    const byStatus = {};
    for (const q of mine) byStatus[q.quoteStatus || '?'] = (byStatus[q.quoteStatus || '?'] || 0) + 1;
    const stats = [
      `Tổng số báo giá đã ghi nhận: ${mine.length}`,
      `Chưa đọc (in đậm trên CRM): ${mine.filter((q) => q.isRead === false).length}`,
      `Theo tình trạng: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(', ')}`,
      `Số báo giá có bình luận được ghi lại: ${withComments.length}`,
    ].join('\n');
    const prompt = `Đánh giá tổng hợp NVKD "${name}" dựa trên các báo giá dưới đây. Nêu thêm các xu hướng lặp lại giữa nhiều báo giá.

THỐNG KÊ
${stats}

CHI TIẾT BÌNH LUẬN
${withComments.map((q) => threadText(q, comments[q.id])).join('\n\n---\n\n') || '(chưa có)'}`;
    await runEval(`s:${name}`, prompt, { staff: name });
  }

  // ---------- Giao diện ----------
  const state = { busy: new Set(), shown: null, error: null, unreadOf: null };
  let host, root;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
    .fab { position: fixed; left: 16px; bottom: 16px; z-index: 2147483646; border: 0; border-radius: 999px;
      padding: 10px 16px; background: #1d4ed8; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.25); }
    .panel { position: fixed; left: 16px; bottom: 64px; z-index: 2147483647; width: min(520px, calc(100vw - 32px));
      max-height: 78vh; overflow: auto; background: #fff; color: #1f2328; border-radius: 12px; font-size: 13px;
      box-shadow: 0 10px 40px rgba(0,0,0,.3); padding: 14px 16px; }
    .panel[hidden] { display: none; }
    h2 { font-size: 15px; margin: 0 0 4px; }
    h3 { font-size: 13px; margin: 14px 0 6px; }
    .muted { color: #656d76; font-size: 12px; }
    .err { color: #cf222e; margin: 8px 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 5px 4px; border-bottom: 1px solid #eaeef2; vertical-align: middle; }
    th { font-size: 12px; color: #656d76; font-weight: 600; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    button.act { border: 1px solid #d0d7de; background: #f6f8fa; border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 12px; }
    button.act:disabled { opacity: .5; cursor: wait; }
    button.link { border: 0; background: none; color: #1d4ed8; cursor: pointer; padding: 0; font-size: 13px; }
    .score { font-weight: 700; }
    .good { color: #1a7f37; } .mid { color: #9a6700; } .bad { color: #cf222e; }
    .result { white-space: pre-wrap; background: #f6f8fa; border-radius: 8px; padding: 10px; margin-top: 8px; line-height: 1.5; }
    .box { border: 1px solid #d0d7de; border-radius: 8px; padding: 10px; }
    .unread a { color: #1d4ed8; text-decoration: none; display: block; padding: 2px 0; }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .x { border: 0; background: none; font-size: 18px; cursor: pointer; color: #656d76; }
  `;

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'dg-root';
    document.documentElement.append(host);
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><button class="fab">📊 Đánh giá NVKD</button><div class="panel" hidden></div>`;
    root.querySelector('.fab').onclick = () => {
      const p = root.querySelector('.panel');
      p.hidden = !p.hidden;
      if (!p.hidden) render();
    };
    root.querySelector('.panel').addEventListener('click', onClick);
  }

  const isOpen = () => root && !root.querySelector('.panel').hidden;

  function setBusy(key, on) {
    on ? state.busy.add(key) : state.busy.delete(key);
    if (on) state.error = null;
    render();
  }

  const scoreCls = (s) => (s == null ? '' : s >= 8 ? 'good' : s >= 6 ? 'mid' : 'bad');
  const scoreHtml = (ev) => (ev?.score != null ? `<span class="score ${scoreCls(ev.score)}">${ev.score}/10</span>` : '');

  async function render() {
    if (!isOpen()) return;
    const [quotes, comments, evals] = await Promise.all([kvGet('quotes'), kvGet('comments'), kvGet('evals')]);
    const all = Object.values(quotes);

    // Gom theo NVKD
    const byStaff = {};
    for (const q of all) {
      const name = staffOf(q, comments[q.id]) || '(không rõ)';
      const s = (byStaff[name] ||= { name, total: 0, unread: [], commented: 0, evaluated: [] });
      s.total++;
      if (q.isRead === false) s.unread.push(q);
      if (comments[q.id]?.threads?.length) s.commented++;
      const ev = evals[`q:${q.id}`];
      if (ev?.score != null) s.evaluated.push(ev.score);
    }
    const staffRows = Object.values(byStaff).sort((a, b) => b.unread.length - a.unread.length || b.total - a.total);

    const qid = currentQuoteId();
    let current = '';
    if (qid) {
      const q = quotes[qid];
      const c = comments[qid];
      const key = `q:${qid}`;
      const ev = evals[key];
      current = `
        <h3>Báo giá đang mở</h3>
        <div class="box">
          <div class="row">
            <div><b>${esc(q?.code || c?.code || '#' + qid)}</b> – ${esc(q?.name || '')}<br>
              <span class="muted">NVKD: ${esc(staffOf(q, c) || '?')} · ${c?.threads?.length || 0} luồng bình luận đã ghi</span></div>
            <button class="act" data-act="eval-quote" data-id="${qid}" ${state.busy.has(key) ? 'disabled' : ''}>
              ${state.busy.has(key) ? 'Đang đánh giá…' : '🤖 Đánh giá'}</button>
          </div>
          ${ev ? `<div class="row" style="margin-top:6px"><span class="muted">Đánh giá lúc ${new Date(ev.at).toLocaleString('vi-VN')}</span>${scoreHtml(ev)}</div><div class="result">${esc(ev.text)}</div>` : ''}
        </div>`;
    }

    const shown = state.shown?.startsWith('s:') ? evals[state.shown] : null;
    const unreadBox = state.unreadOf && byStaff[state.unreadOf]
      ? `<h3>Báo giá chưa đọc – ${esc(state.unreadOf)}</h3><div class="box unread">${
          byStaff[state.unreadOf].unread
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((q) => `<a href="/co-hoi/update/${q.id}"><b>${esc(q.code)}</b> · ${esc(q.name)} <span class="muted">(${fmtTime(q.createdAt)})</span></a>`)
            .join('') || '<span class="muted">Không có</span>'
        }</div>`
      : '';

    root.querySelector('.panel').innerHTML = `
      <div class="row"><h2>Đánh giá nhân viên kinh doanh</h2><button class="x" data-act="close">×</button></div>
      <div class="muted">Dựa trên ${all.length} báo giá và ${Object.keys(comments).length} báo giá có bình luận mà extension đã ghi lại khi bạn xem CRM.
      Mở trang Báo giá để cập nhật danh sách; mở từng báo giá để ghi lại bình luận.</div>
      ${state.error ? `<div class="err">Lỗi: ${esc(state.error)}</div>` : ''}
      ${current}
      <h3>Theo NVKD</h3>
      <table>
        <tr><th>NVKD</th><th class="num">Báo giá</th><th class="num">Chưa đọc</th><th class="num">Có BL</th><th class="num">Điểm TB</th><th></th></tr>
        ${staffRows
          .map((s) => {
            const key = `s:${s.name}`;
            const avg = s.evaluated.length ? Math.round((s.evaluated.reduce((a, b) => a + b, 0) / s.evaluated.length) * 10) / 10 : null;
            const sev = evals[key];
            return `<tr>
              <td>${sev ? `<button class="link" data-act="show" data-key="${esc(key)}">${esc(s.name)}</button>` : esc(s.name)}</td>
              <td class="num">${s.total}</td>
              <td class="num">${s.unread.length ? `<button class="link" data-act="unread" data-staff="${esc(s.name)}"><b>${s.unread.length}</b></button>` : 0}</td>
              <td class="num">${s.commented}</td>
              <td class="num">${avg != null ? `<span class="score ${scoreCls(avg)}">${avg}</span>` : '–'}</td>
              <td><button class="act" data-act="eval-staff" data-staff="${esc(s.name)}" ${state.busy.has(key) || !s.commented ? 'disabled' : ''}>
                ${state.busy.has(key) ? 'Đang…' : '🤖 Tổng hợp'}</button></td>
            </tr>`;
          })
          .join('') || '<tr><td colspan="6" class="muted">Chưa có dữ liệu – hãy mở trang Báo giá.</td></tr>'}
      </table>
      ${unreadBox}
      ${shown ? `<h3>Đánh giá tổng hợp – ${esc(shown.staff)} ${scoreHtml(shown)}</h3><div class="muted">Lúc ${new Date(shown.at).toLocaleString('vi-VN')}</div><div class="result">${esc(shown.text)}</div>` : ''}
    `;
  }

  function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') root.querySelector('.panel').hidden = true;
    else if (act === 'eval-quote') evaluateQuote(Number(b.dataset.id));
    else if (act === 'eval-staff') evaluateStaff(b.dataset.staff);
    else if (act === 'show') {
      state.shown = b.dataset.key;
      render();
    } else if (act === 'unread') {
      state.unreadOf = state.unreadOf === b.dataset.staff ? null : b.dataset.staff;
      render();
    }
  }

  // ERP là SPA: theo dõi đổi trang để cập nhật mục "Báo giá đang mở"
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      render();
    }
  }, 1000);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
