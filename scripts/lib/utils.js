// Hàm dùng chung. Các file trong cùng một mục "files" chạy chung một scope,
// nên khai báo trên window để file sau dùng được.
window.DG = window.DG || {};

DG.toast = function (text) {
  const el = document.createElement('div');
  el.textContent = text;
  Object.assign(el.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647,
    background: '#1f883d', color: '#fff', padding: '8px 12px',
    borderRadius: '6px', font: '13px system-ui, sans-serif',
  });
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
};
