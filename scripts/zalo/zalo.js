// Chạy trong world USER_SCRIPT trên chat.zalo.me.
// Nhận "việc gửi tin" do bảng Trợ lý ERP (trang CRM) xếp hàng trong kv 'zaloJobs',
// tìm đúng người nhận theo tên NVKD, mở cuộc trò chuyện, dán tin nhắn và gửi.
// An toàn: chỉ gửi khi tên kết quả tìm kiếm KHỚP ĐÚNG tên cần tìm và tiêu đề cuộc trò chuyện cũng khớp;
// không chắc chắn thì dừng và báo lỗi lại cho bảng (không gửi nhầm người).
(() => {
  if (window.top !== window || window.__dgZalo) return;
  window.__dgZalo = true;

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
  const norm = (s) =>
    String(s || '')
      .normalize('NFC')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  const TAB = Math.random().toString(36).slice(2);

  // Nhịp tim: bảng CRM biết đã có tab Zalo đang mở thì không mở thêm tab mới
  const beat = () => call({ type: 'kv.set', key: 'zaloAlive', value: { tab: TAB, at: Date.now(), url: location.href } }).catch(() => {});
  beat();
  setInterval(beat, 3000);

  const visible = (e) => !!e && e.getClientRects().length > 0;
  async function waitFor(fn, ms = 8000, step = 250) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }
  const setStatus = (id, patch) => kvMerge('zaloJobs', { [id]: patch }).catch(() => {});

  // Ô tìm kiếm của Zalo Web
  const searchBox = () =>
    document.querySelector('#contact-search-input') ||
    [...document.querySelectorAll('input')].find((i) => visible(i) && /tìm kiếm|search/i.test(i.placeholder || ''));
  function typeInto(input, text) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    input.click();
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // Các phần tử chữ trong danh sách kết quả có tên KHỚP ĐÚNG
  // Phần tử (sâu nhất) có chữ KHỚP ĐÚNG tên – tên trong kết quả tìm kiếm thường bị tách thành nhiều <span> tô sáng
  function exactMatches(name) {
    const want = norm(name);
    const out = [];
    for (const e of document.querySelectorAll('div, span, a, p, div-b16, div-14, div-16')) {
      if (!visible(e) || norm(e.textContent) !== want) continue;
      if ([...e.children].some((c) => norm(c.textContent) === want)) continue; // còn con khớp → lấy con
      if (e.closest('#richInput, [contenteditable="true"], input')) continue;
      const r = e.getBoundingClientRect();
      if (r.left > window.innerWidth * 0.45) continue; // kết quả nằm ở cột trái
      out.push(e);
    }
    // Ưu tiên kết quả trong khung tìm kiếm (không phải danh sách hội thoại bên dưới)
    return out.sort((a, b) => !!a.closest('#conversationList') - !!b.closest('#conversationList'));
  }
  // Ô soạn tin
  const chatInput = () =>
    [...document.querySelectorAll('#richInput, #input_line_0, [contenteditable="true"], [contenteditable=""], textarea')].find(
      (e) => visible(e) && e.getBoundingClientRect().top > window.innerHeight * 0.6 && e.getBoundingClientRect().left > window.innerWidth * 0.2
    ) || document.querySelector('#richInput');
  // Chữ thật trong ô soạn (bỏ dòng gợi ý "Nhập @, tin nhắn tới …")
  const typed = (el) => norm((el?.innerText ?? el?.value ?? '').replace(/^Nhập @.*$/m, ''));
  // Tiêu đề cuộc trò chuyện đang mở có chứa tên người nhận
  // Khung chat đang mở đúng người: tên hiện ở phía trên khung phải
  const headerHas = (name) => {
    const want = norm(name);
    return [...document.querySelectorAll('div, span, h1, h2, h3, div-b16, div-16, div-18')].some((e) => {
      if (!visible(e) || !norm(e.textContent).startsWith(want) || norm(e.textContent).length > want.length + 40) return false;
      const r = e.getBoundingClientRect();
      return r.left > window.innerWidth * 0.2 && r.top < 160;
    });
  };

  // Ô soạn của Zalo (#richInput + dòng #input_line_0) là trình soạn tự viết: thử lần lượt nhiều cách điền, cách nào ra chữ thì dừng
  async function pasteText(el, text, html, log = () => {}) {
    const box = document.querySelector('#richInput') || el;
    const line = document.querySelector('#input_line_0') || box;
    const r = line.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + 10, clientY: r.top + r.height / 2, button: 0 };
    for (const t of ['mousedown', 'mouseup', 'click']) line.dispatchEvent(new MouseEvent(t, o));
    box.focus();
    line.focus?.();
    await sleep(300);
    const tgt = () => (box.contains(document.activeElement) || document.activeElement === box ? document.activeElement : box);
    const ok = () => typed(box).length >= Math.min(15, norm(text).length);
    const sel = () => {
      // Đặt con trỏ vào cuối dòng soạn
      try {
        const rg = document.createRange();
        rg.selectNodeContents(line);
        rg.collapse(false);
        const s2 = getSelection();
        s2.removeAllRanges();
        s2.addRange(rg);
      } catch {}
    };
    sel();
    log(`ô soạn: ce=${box.getAttribute('contenteditable')} · focus=${document.activeElement?.id || document.activeElement?.tagName}`);
    // 1) Sự kiện dán (clipboardData)
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      if (html) dt.setData('text/html', html);
      tgt().dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch (e) {
      log(`paste lỗi ${e}`);
    }
    await sleep(500);
    if (ok()) return 'paste';
    // 2) beforeinput / input kiểu gõ chữ
    sel();
    tgt().dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromPaste', data: text, bubbles: true, cancelable: true, dataTransfer: (() => { try { const d = new DataTransfer(); d.setData('text/plain', text); return d; } catch { return null; } })() }));
    await sleep(300);
    if (ok()) return 'beforeinput';
    // 3) execCommand insertText
    sel();
    document.execCommand('insertText', false, text);
    await sleep(300);
    if (ok()) return 'insertText';
    // 4) Ghi thẳng vào dòng soạn rồi báo input cho trình soạn cập nhật
    line.textContent = text;
    box.classList.remove('empty');
    box.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
    await sleep(300);
    log(`sau khi ghi thẳng: "${typed(box).slice(0, 40)}" html=${box.innerHTML.slice(0, 200)}`);
    return ok() ? 'direct' : '';
  }
  // Gửi thông tin chẩn đoán về máy chủ (để chỉnh lại khi Zalo đổi giao diện)
  function debugDump(step, el, extra = '') {
    const foot = el?.closest('footer, [class*="footer"], [class*="chat-input"], [class*="ChatInput"]') || el?.parentElement?.parentElement?.parentElement;
    const cands = [...document.querySelectorAll('[contenteditable], textarea, #richInput, #input_line_0')].map((e) => ({
      tag: e.tagName, id: e.id, cls: String(e.className).slice(0, 120), ce: e.getAttribute('contenteditable'), vis: visible(e),
      top: Math.round(e.getBoundingClientRect().top), left: Math.round(e.getBoundingClientRect().left), text: (e.innerText || '').slice(0, 80),
    }));
    return call({ type: 'remote.push', ns: 'zaloDebug', patch: { last: { step, at: Date.now(), cands, chosen: el ? { tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 120) } : null,
      foot: (foot?.outerHTML || '').slice(0, 6000), extra, w: innerWidth, h: innerHeight } } }).catch(() => {});
  }
  function pressSend(el) {
    const btn = [...document.querySelectorAll('[icon*="Sent"], [data-translate-title*="SEND"], [title="Gửi"], .send-btn, [class*="send-btn"]')].find(visible);
    if (btn) return btn.click();
    const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keypress', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
  }

  const ZVER = '1.2.162';
  let trace = [];
  let runId = '';
  // Mỗi bước 1 dòng riêng trên máy chủ (không ghi đè nhau khi gửi lệch thứ tự)
  const tr = (t) => {
    trace.push(t);
    call({ type: 'remote.push', ns: 'zaloDebug', patch: { [`${runId}-${String(trace.length).padStart(2, '0')}`]: { ver: ZVER, at: Date.now(), t, hidden: document.hidden } } }).catch(() => {});
  };
  async function runJob(id, job) {
    trace = [];
    runId = new Date().toISOString().slice(5, 19);
    tr(`bắt đầu gửi cho ${job.to}`);
    const fail = (why) => {
      tr(`LỖI: ${why}`);
      return setStatus(id, { ...job, status: 'error', error: why, doneAt: Date.now() });
    };
    const box = await waitFor(searchBox, 20000);
    if (!box) return fail('Chưa thấy ô tìm kiếm của Zalo (Zalo chưa đăng nhập / chưa tải xong).');
    tr('thấy ô tìm kiếm');
    const names = [...new Set([job.zaloName, job.to].filter(Boolean))];
    let hit = null;
    let used = '';
    for (const name of names) {
      typeInto(box, name);
      tr(`gõ "${name}"`);
      await sleep(1500);
      const list = await waitFor(() => (exactMatches(name).length ? exactMatches(name) : null), 5000);
      if (list?.length) {
        hit = list[0];
        used = name;
        break;
      }
    }
    tr(hit ? `thấy kết quả "${used}" (${hit.tagName}.${String(hit.className).slice(0, 60)})` : 'không thấy kết quả');
    if (!hit) return fail(`Không tìm thấy liên hệ Zalo tên đúng "${names.join('" / "')}". Đặt tên Zalo cho NVKD này rồi gửi lại.`);
    // Zalo mở chat theo chuỗi sự kiện chuột (mousedown/up), không chỉ click → bấm thật từ phần tử tên lên các khung cha
    const realClick = (el) => {
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
      for (const t of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
        el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, { ...o, pointerId: 1, isPrimary: true }) : new MouseEvent(t, o));
    };
    const chain = [];
    for (let e = hit; e && e !== document.body && chain.length < 6; e = e.parentElement) chain.push(e);
    let input = null;
    const opened = () => (headerHas(used) ? chatInput() : null);
    // Cách 1: click thường từng tầng · Cách 2: chuỗi sự kiện chuột · Cách 3: phím mũi tên + Enter trong ô tìm kiếm
    for (const [name, fn] of [['click', (el) => el.click()], ['mouse', realClick]]) {
      for (const el of chain) {
        fn(el);
        input = await waitFor(opened, 1200);
        if (input) {
          tr(`mở chat bằng ${name} trên ${el.tagName}.${String(el.className).slice(0, 60)}`);
          break;
        }
      }
      if (input) break;
    }
    if (!input) {
      const k = (key, code) => box.dispatchEvent(new KeyboardEvent('keydown', { key, code, keyCode: code, which: code, bubbles: true, cancelable: true }));
      box.focus();
      k('ArrowDown', 40);
      await sleep(300);
      k('Enter', 13);
      input = await waitFor(opened, 2000);
      if (input) tr('mở chat bằng phím Enter');
    }
    if (!input) {
      debugDump('no-input', null, chain.map((e) => `${e.tagName}#${e.id}.${String(e.className).slice(0, 80)} [${e.getAttribute('data-id') || ''}]`).join(' > ') + '\n' + (chain[chain.length - 1]?.outerHTML || '').slice(0, 4000));
      return fail('Đã tìm thấy nhưng không mở được khung chat của người này.');
    }
    await sleep(800);
    if (!headerHas(used)) return fail(`Khung chat đang mở không phải "${used}" – đã dừng, không gửi.`);
    const how = await pasteText(chatInput() || input, job.text, job.html, tr);
    tr(`điền nội dung: ${how || 'KHÔNG ĐƯỢC'}`);
    debugDump(`paste:${how || 'fail'}`, chatInput() || input);
    if (!how) return fail('Không dán được nội dung vào ô chat.');
    await sleep(500);
    // Chế độ thử: chỉ soạn sẵn, không bấm gửi
    if (job.draft) return setStatus(id, { ...job, status: 'sent', drafted: true, doneAt: Date.now(), via: used });
    pressSend(input);
    await sleep(1500);
    const left = typed(chatInput());
    if (left.length > 10) return fail('Đã dán nội dung nhưng chưa gửi được – bấm Enter trong Zalo để gửi.');
    await setStatus(id, { ...job, status: 'sent', doneAt: Date.now(), via: used });
  }

  let busy = false;
  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const jobs = await kvGet('zaloJobs');
      const next = Object.entries(jobs)
        .filter(([, j]) => j?.status === 'pending' && Date.now() - j.at < 10 * 60e3)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) return;
      const [id, job] = next;
      // Nhận việc (tránh 2 tab Zalo cùng gửi)
      await setStatus(id, { ...job, status: 'sending', tab: TAB, startAt: Date.now() });
      await sleep(300);
      const again = (await kvGet('zaloJobs'))[id];
      if (again?.tab !== TAB) return;
      await runJob(id, job).catch((e) => {
        tr(`NGOẠI LỆ: ${e?.stack || e}`);
        return setStatus(id, { ...job, status: 'error', error: String(e.message || e), doneAt: Date.now() });
      });
    } catch {
    } finally {
      busy = false;
    }
  }
  setInterval(poll, 1500);
})();
