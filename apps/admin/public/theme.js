// 主题预涂装：在首帧前恢复暗色偏好，避免闪白。
// 独立成外部文件是因为管理面板启用了 CSP（script-src 'self'），内联脚本会被拦截。
try {
  if (localStorage.getItem('nenochat.admin.theme') === 'dark') {
    document.documentElement.classList.add('dark')
  }
} catch {}
