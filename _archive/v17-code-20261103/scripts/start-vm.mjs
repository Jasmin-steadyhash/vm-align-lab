// 两种方案共同的起点：项目保存的 VM，但所有可调参数（tunableParams）回到配置默认值 = 刚生成完、还没对齐的状态。
// 开关、眼眶遮罩 8 点等不可调的保持项目里的值
export function startVmOf(savedVm, specs) {
  const vm = { ...savedVm };
  for (const p of specs) vm[p.name] = p.default;
  return vm;
}
