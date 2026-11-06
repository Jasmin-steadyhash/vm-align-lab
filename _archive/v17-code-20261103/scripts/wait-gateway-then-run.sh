#!/bin/sh
# 等网关恢复再跑：每 10 分钟测一次定点耗时，连续两次 ≤ 30 秒就跑 v16（耳麦女孩），最多等 6 小时
cd "$(dirname "$0")/.."
N=dfb3bc24-86fd-4619-b6e3-f85e1fcc4e29; good=0
for i in $(seq 1 36); do
  # 只取纯数字那一行（页面日志也会打到 stdout，tail -1 可能拿到日志而不是秒数）
  s=$(LAB_PORT=5289 node scripts/probe-latency.mjs e2e-$N 2>/dev/null | grep -E '^[0-9]+$' | tail -1)
  echo "$(date '+%H:%M') 定点耗时 ${s}s" >> logs/gateway-probe.log
  if [ "${s:-999}" -le 30 ] 2>/dev/null; then good=$((good+1)); else good=0; fi
  if [ $good -ge 2 ]; then
    echo "$(date '+%H:%M') 网关恢复，开跑 v16" >> logs/gateway-probe.log
    caffeinate -di & CP=$!
    LAB_PORT=5231 node scripts/agent.mjs v16 e2e-$N > logs/e2e-agent-v16-$N.log 2>&1
    LAB_PORT=5270 node scripts/judge.mjs e2e agent/v16 -- e2e-$N > logs/e2e-judge-v16-$N.log 2>&1
    cp results/judge/e2e/e2e-$N-agent_v16-full.png results/human/e2e/dfb3bc24-final-v16.png 2>/dev/null
    node scripts/report.mjs v16 > /dev/null
    kill $CP; echo "$(date '+%H:%M') v16 跑完" >> logs/gateway-probe.log; exit 0
  fi
  sleep 600
done
echo "$(date '+%H:%M') 等了 6 小时网关没恢复，放弃" >> logs/gateway-probe.log
