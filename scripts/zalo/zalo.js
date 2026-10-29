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
  // Mép phải của cột trái (danh sách hội thoại / kết quả tìm kiếm) – khung chat nằm bên phải mép này
  const LEFT_COL = () => {
    const l = document.querySelector('#conversationList, #contact-search-input');
    const r = l?.closest('[class*="sidebar"], [class*="Sidebar"], nav, aside')?.getBoundingClientRect() || l?.getBoundingClientRect();
    return Math.max(200, Math.min((r?.right || 360) - 10, window.innerWidth * 0.5));
  };
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
  // Ô soạn đang hiện: chế độ thường là #richInput; bật "Định dạng tin nhắn" thì là trình soạn khác (contenteditable id ngẫu nhiên)
  const chatInput = () => {
    const inArea = (e) => {
      if (!visible(e)) return false;
      const r = e.getBoundingClientRect();
      return r.top > window.innerHeight * 0.5 && r.left > LEFT_COL() && r.width > 40;
    };
    // Trình soạn định dạng (khi nút A✎ đang bật): contenteditable lớn, không phải #richInput
    const fmtOn = !!document.querySelector('[data-id="div_RTF_Menu"].focused, [icon="TextFormat_24_Line"].focused');
    if (fmtOn) {
      const ed = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => e.id !== 'richInput' && inArea(e) && e.getBoundingClientRect().width > 150);
      if (ed) return ed;
    }
    const rich = document.querySelector('#richInput');
    if (rich && inArea(rich)) return rich;
    return [...document.querySelectorAll('[contenteditable="true"], textarea')].find(inArea) || null;
  };
  // Chữ thật trong ô soạn (bỏ dòng gợi ý "Nhập @, tin nhắn tới …")
  const typed = (el) => norm((el?.innerText ?? el?.value ?? '').replace(/^Nhập @.*$/gm, '').replace(/^Nhấn .*định dạng tin nhắn.*$/gim, ''));
  // Tiêu đề cuộc trò chuyện đang mở có chứa tên người nhận
  // Khung chat đang mở đúng người: tên hiện ở phía trên khung phải
  const headerHas = (name) => {
    const want = norm(name);
    return [...document.querySelectorAll('div, span, h1, h2, h3, div-b16, div-16, div-18')].some((e) => {
      if (!visible(e) || !norm(e.textContent).startsWith(want) || norm(e.textContent).length > want.length + 40) return false;
      const r = e.getBoundingClientRect();
      return r.left > LEFT_COL() && r.top < 160;
    });
  };

  // Ô soạn của Zalo (#richInput + dòng #input_line_0) là trình soạn tự viết: thử lần lượt nhiều cách điền, cách nào ra chữ thì dừng
  async function pasteText(el, text, html, log = () => {}) {
    const ed = chatInput() || el;
    const r = ed.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + 20, clientY: r.top + Math.min(20, r.height / 2), button: 0 };
    for (const t of ['mousedown', 'mouseup', 'click']) ed.dispatchEvent(new MouseEvent(t, o));
    ed.focus();
    await sleep(300);
    const ok = () => typed(ed).length >= Math.min(15, norm(text).length);
    const sel = () => {
      try {
        const rg = document.createRange();
        rg.selectNodeContents(ed);
        rg.collapse(false);
        const s2 = getSelection();
        s2.removeAllRanges();
        s2.addRange(rg);
      } catch {}
    };
    sel();
    const tgt = () => (ed.contains(document.activeElement) ? document.activeElement : ed);
    log(`ô soạn: ${ed.tagName}#${ed.id}.${String(ed.className).slice(0, 50)} · focus=${document.activeElement?.id || document.activeElement?.tagName}`);
    // 1) Sự kiện dán (kèm HTML để giữ chữ đậm / màu ở chế độ định dạng)
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      if (html) dt.setData('text/html', html);
      tgt().dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch (e) {
      log(`paste lỗi ${e}`);
    }
    await sleep(600);
    if (ok()) return 'paste';
    // 2) execCommand chèn HTML / chữ
    sel();
    if (html) document.execCommand('insertHTML', false, html);
    await sleep(300);
    if (ok()) return 'insertHTML';
    sel();
    document.execCommand('insertText', false, text);
    await sleep(300);
    if (ok()) return 'insertText';
    log(`không điền được · html ô soạn: ${(ed.parentElement?.outerHTML || '').slice(0, 1500)}`);
    return '';
  }
  // Nút "Định dạng tin nhắn" trên thanh công cụ ô soạn – bấm nếu chưa bật
  async function enableFormat() {
    const btns = [...document.querySelectorAll('[title], [data-translate-title], [icon]')].filter(visible);
    const btn = btns.find((e) => /định dạng|format|rich ?text|font/i.test(`${e.getAttribute('title') || ''} ${e.getAttribute('data-translate-title') || ''} ${e.getAttribute('icon') || ''}`));
    if (!btn) {
      const bar = document.querySelector('#chat-input-content-id')?.parentElement?.parentElement;
      call({ type: 'remote.push', ns: 'zaloDebug', patch: { toolbar: { at: Date.now(), html: (bar?.outerHTML || '').replace(/<div id="chat-input-content-id"[\s\S]*$/, '').slice(0, 6000) } } }).catch(() => {});
      return 'không thấy nút';
    }
    const isOn = () => /active|selected|--on|checked|focused/i.test(`${btn.className} ${btn.parentElement?.className || ''}`) || btn.getAttribute('aria-pressed') === 'true' || !!document.querySelector('[class*="format-toolbar"], [class*="text-format"], [class*="richtext-toolbar"]');
    const info = `${btn.tagName}.${String(btn.className).slice(0, 60)} title=${btn.getAttribute('title') || btn.getAttribute('data-translate-title') || ''}`;
    if (isOn()) return `đã bật (${info})`;
    btn.click();
    await sleep(500);
    const bar = btn.closest('[class*="toolbar"], [class*="chat-box-input"], footer') || btn.parentElement?.parentElement;
    call({ type: 'remote.push', ns: 'zaloDebug', patch: { toolbar: { at: Date.now(), html: (bar?.outerHTML || '').slice(0, 8000) } } }).catch(() => {});
    return `bấm bật (${info})`;
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
  // Khung soạn tin (ô nhập + thanh công cụ + nút emoji/gửi) – chỉ tìm nút gửi trong vùng này, không đụng thanh bên trái
  function chatBox() {
    const core = document.querySelector('#chat-input-content-id') || chatInput();
    if (!core) return null;
    const cr = core.getBoundingClientRect();
    let box = core;
    for (let p = core.parentElement; p && p !== document.body; p = p.parentElement) {
      const r = p.getBoundingClientRect();
      if (r.left < LEFT_COL() - 5 || r.top < cr.top - 140) break;
      box = p;
    }
    return box;
  }
  function findSend() {
    const box = chatBox();
    if (!box) return null;
    const ok = (e) => visible(e) && !e.closest('[contenteditable="true"], [class*="leftbar"]');
    const attrs = (e) => `${String(e.className?.baseVal ?? e.className)} ${e.getAttribute('icon') || ''} ${e.getAttribute('title') || ''} ${e.getAttribute('data-translate-title') || ''} ${e.getAttribute('data-id') || ''}`;
    const hit = [...box.querySelectorAll('*')].find((e) => ok(e) && /send|sent|paper-plane|(^|\s)gửi(\s|$)/i.test(attrs(e)) && !/sticker|emoji|file|image|ảnh/i.test(attrs(e)));
    if (hit) return hit.closest('[class*="btn"], [role="button"], button') || hit;
    // dự phòng: nút ngoài cùng bên phải ở hàng dưới cùng khung soạn (bên phải nút emoji)
    const r = box.getBoundingClientRect();
    const leaf = [...box.querySelectorAll('i, svg, img, [class*="btn"], [role="button"], button')]
      .filter((e) => ok(e) && !/emoji|sticker/i.test(attrs(e)))
      .map((e) => [e, e.getBoundingClientRect()])
      .filter(([, br]) => br.width > 8 && br.width < 64 && r.right - br.right < 60 && r.bottom - br.bottom < 60)
      .sort((x, y) => y[1].right - x[1].right || y[1].bottom - x[1].bottom)[0]?.[0];
    return leaf ? leaf.closest('[class*="btn"], [role="button"], button') || leaf : null;
  }
  function pressSend(el, log = () => {}) {
    const btn = findSend();
    if (btn) {
      log(`bấm nút gửi: ${btn.tagName}.${String(btn.className?.baseVal ?? btn.className).slice(0, 60)} ${btn.getAttribute('title') || btn.getAttribute('icon') || ''}`);
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      return;
    }
    log('không thấy nút gửi → Enter');
    const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keypress', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
  }

  const ZVER = '1.2.315';
  let trace = [];
  let runId = '';
  // Mỗi bước 1 dòng riêng trên máy chủ (không ghi đè nhau khi gửi lệch thứ tự)
  const tr = (t) => {
    trace.push(t);
    call({ type: 'remote.push', ns: 'zaloDebug', patch: { [`${runId}-${String(trace.length).padStart(2, '0')}`]: { ver: ZVER, at: Date.now(), t, hidden: document.hidden } } }).catch(() => {});
  };
  // Ghi lại deal đã hỏi (đồng bộ giữa các máy) – mỗi deal chỉ hỏi 1 lần, mỗi người 1 tin / 30 phút
  // Tin nhắc cả đội đã gửi → lưu lần gần nhất lên máy chủ (đồng bộ mọi máy)
  const markTeam = (job, drafted) =>
    job.team && !drafted
      ? kvMerge('teamRemind', { last: { at: Date.now(), slot: job.slot || '', image: !!job.image || !!job.wasImage, n: job.n || 0 }, ...(job.slot ? { [job.slot]: { at: Date.now(), sent: true } } : {}) }).catch(() => {})
      : null;
  const markSent = (job, drafted) => (job.qid ? kvMerge('zaloSent', { [job.qid]: { to: job.to, code: job.code, at: Date.now(), drafted } }).catch(() => {}) : null);
  async function runJob(id, job) {
    trace = [];
    runId = new Date().toISOString().slice(5, 19);
    tr(`bắt đầu gửi cho ${job.to}`);
    // Kiểm tra lại trước khi gửi (phòng 2 máy cùng bấm)
    const sentAll = await kvGet('zaloSent');
    if (job.qid && sentAll[job.qid]) return setStatus(id, { ...job, status: 'error', error: 'Deal này đã hỏi rồi – không gửi lại.', doneAt: Date.now() });
    const lastTo = Math.max(0, ...Object.values(sentAll).filter((x) => norm(x?.to) === norm(job.to)).map((x) => x.at || 0));
    if (Date.now() - lastTo < 30 * 60e3) return setStatus(id, { ...job, status: 'error', error: `Đã nhắn ${job.to} trong 30 phút qua – chưa soạn tin mới.`, doneAt: Date.now() });
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
    // Chống trùng: khung chat đã có tin nhắn chứa mã báo giá này (gửi từ trước / bằng tay) → không soạn lại
    await sleep(800);
    const inp = chatInput();
    const inTop = inp ? inp.getBoundingClientRect().top - 40 : window.innerHeight * 0.8;
    const dup = job.code && [...document.querySelectorAll('div, span')].some((e) => {
      if (e.children.length > 3 || !visible(e) || !(e.textContent || '').includes(job.code)) return false;
      if (inp && (inp.contains(e) || e.contains(inp))) return false;
      const r = e.getBoundingClientRect();
      return r.left > LEFT_COL() && r.top > 60 && r.bottom < inTop;
    });
    if (dup) {
      tr(`đã có tin nhắn ${job.code} trong chat → bỏ qua`);
      await markSent(job, false);
      return setStatus(id, { ...job, status: 'error', error: `Trong chat với ${used} đã có tin nhắn về ${job.code} – không soạn lại.`, doneAt: Date.now() });
    }
    // Bật chế độ "Định dạng tin nhắn" (nút A✎ trên thanh công cụ) để giữ chữ đậm / màu khi dán
    const fmt = await enableFormat();
    tr(`định dạng: ${fmt}`);
    // Gửi dạng hình: dán ảnh PNG (như Ctrl+V ảnh) – Zalo mở khung xem trước ảnh
    if (job.image) {
      const blob = await (await fetch(job.image)).blob();
      const file = new File([blob], 'nhac-ca-doi.png', { type: 'image/png' });
      const el = chatInput() || input;
      el.focus();
      const dt = new DataTransfer();
      dt.items.add(file);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      tr('đã dán ảnh');
      await sleep(1500);
      if (!job.draft) {
        // tự gửi: bấm nút gửi trong khung xem trước ảnh nếu có, không thì Enter
        const sendBtn = [...document.querySelectorAll('[data-translate-inner="STR_SEND"], [title="Gửi"], button')].find((b) => visible(b) && /^Gửi$/i.test((b.innerText || '').trim()));
        if (sendBtn) sendBtn.click();
        else pressSend(el);
        await sleep(2000);
      }
      // Kèm câu chữ (vd. "Khách của ai xem xét thúc khách kéo đơn về…") vào ô soạn ngay sau ảnh
      if (job.caption) {
        const box = chatInput() || el;
        await pasteText(box, job.caption, '', tr);
        tr('đã điền câu kèm ảnh');
        if (!job.draft) {
          await sleep(500);
          pressSend(chatInput() || box);
          await sleep(1200);
        }
      }
      await markTeam({ ...job, wasImage: true }, !!job.draft);
      return setStatus(id, { ...job, image: null, status: 'sent', drafted: !!job.draft, doneAt: Date.now(), via: used });
    }
    const how = await pasteText(chatInput() || input, job.text, job.html, tr);
    const rich = document.querySelector('#richInput');
    const edn = chatInput();
    tr(`sau khi dán: đậm=${!!edn?.querySelector('b, strong, [style*="bold"], [style*="700"]')} · màu=${!!edn?.querySelector('[style*="color"]')} · ${(edn?.innerHTML || '').slice(0, 600)}`);
    tr(`điền nội dung: ${how || 'KHÔNG ĐƯỢC'}`);
    debugDump(`paste:${how || 'fail'}`, chatInput() || input);
    if (!how) return fail('Không dán được nội dung vào ô chat.');
    await sleep(500);
    // Chế độ thử: chỉ soạn sẵn, không bấm gửi
    if (job.draft) {
      await markSent(job, true);
      return setStatus(id, { ...job, status: 'sent', drafted: true, doneAt: Date.now(), via: used });
    }
    pressSend(chatInput() || input, tr);
    await sleep(1500);
    // Gửi thành công = vẫn đúng khung chat người nhận + ô soạn còn đó và đã trống
    const sentOk = () => headerHas(used) && !!chatInput() && typed(chatInput()).length < 10;
    if (!sentOk() && headerHas(used) && chatInput()) {
      // thử Enter trực tiếp vào ô soạn
      const el2 = chatInput();
      el2.focus();
      for (const t of ['keydown', 'keypress', 'keyup']) el2.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      await sleep(1500);
      tr(`sau Enter: còn ${typed(chatInput()).length} ký tự`);
    }
    if (!sentOk()) {
      const box = chatBox();
      call({ type: 'remote.push', ns: 'zaloDebug', patch: { sendbox: { at: Date.now(), html: (box?.outerHTML || '').replace(/<div[^>]*data-component="rtf-block"[\s\S]*?<\/div>/g, '').slice(0, 12000) } } }).catch(() => {});
      tr(`chưa gửi được · đúng khung=${headerHas(used)} · ô soạn=${!!chatInput()}`);
      return fail('Đã dán nội dung nhưng chưa gửi được – bấm nút gửi trong Zalo.');
    }
    tr('đã gửi');
    // Ảnh kèm (vd. ảnh trong báo cáo bảo trì): dán từng ảnh (như Ctrl+V) rồi bấm Gửi ở khung xem trước
    for (const [i, src] of (job.images || []).entries()) {
      try {
        const blob = await (await fetch(src)).blob();
        const file = new File([blob], `anh-${i + 1}.jpg`, { type: blob.type || 'image/jpeg' });
        const el = chatInput() || input;
        el.focus();
        const dt = new DataTransfer();
        dt.items.add(file);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        await sleep(1800);
        const sendBtn = [...document.querySelectorAll('[data-translate-inner="STR_SEND"], [title="Gửi"], button')].find((b) => visible(b) && /^Gửi$/i.test((b.innerText || '').trim()));
        if (sendBtn) sendBtn.click();
        else pressSend(chatInput() || el);
        await sleep(2200);
        tr(`đã gửi ảnh ${i + 1}/${job.images.length}`);
      } catch (e) {
        tr(`ảnh ${i + 1} lỗi: ${e}`);
      }
    }
    await markSent(job, false);
    await markTeam(job, false);
    await setStatus(id, { ...job, images: job.images ? job.images.length : undefined, status: 'sent', doneAt: Date.now(), via: used });
    // Tin nhắc cả đội: gửi xong tự đóng tab Zalo do trợ lý mở (không còn việc nào chờ)
    if (job.team) {
      await sleep(2000);
      const more = Object.values(await kvGet('zaloJobs')).some((j) => j?.status === 'pending' && Date.now() - j.at < 10 * 60e3);
      if (!more && (window.opener || window.name === 'dg-zalo')) {
        tr('đóng tab Zalo');
        window.close();
      }
    }
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
