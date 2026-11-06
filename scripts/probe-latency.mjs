// 测一次网关定点速度（gpt-6.1-sol，耳麦女孩主图），输出秒数；失败输出 999
import { openLab, projectInput } from './lab.mjs';
import { locate, POINTS_WHITE } from './landmarks.mjs';
import { setUsageTag } from './usage.mjs';
setUsageTag('latency-probe');
const lab = await openLab();
await lab.call('loadProject', projectInput(process.argv[2])); await lab.call('loadMaster');
const img = await lab.call('masterForPoints'); await lab.close();
const t0 = Date.now(); const r = await locate('gpt-6.1-sol', img, POINTS_WHITE);
console.log(r ? ((Date.now() - t0) / 1000).toFixed(0) : 999);
