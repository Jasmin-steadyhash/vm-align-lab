#!/bin/sh
# 完整流程一键跑：主图目录里每张图 = 一个新项目
#   1) 每张主图按 Studio 方式生成各组件 N 张候选（并行最多 3 个项目）
#   2) agent（默认 v15）逐个项目对齐；3) 新评审（结果名 e2e）；4) 按项目统计 token / 费用
# 用法：sh scripts/e2e-all.sh <主图目录> [版本 v15] [每组件候选数 3] [模板 riv]
# 前提：本地 worker(8790) + forge(3110) 在跑；跑之前开 caffeinate -di
set -e
cd "$(dirname "$0")/.."
DIR="$1"; VER="${2:-v15}"; N="${3:-3}"; TPL="${4:-龙虾小女孩26.10.28.1.riv}"
[ -d "$DIR" ] || { echo "用法：sh scripts/e2e-all.sh <主图目录> [版本] [候选数] [模板]"; exit 1; }
IDS=""; i=0
for f in "$DIR"/*.png "$DIR"/*.jpg "$DIR"/*.jpeg "$DIR"/*.webp; do
  [ -f "$f" ] || continue
  name=$(basename "$f" | sed 's/\.[^.]*$//' | tr -c 'A-Za-z0-9_\n-' '_')
  IDS="$IDS e2e-$name"
  if [ -f "data/e2e/$name/project.json" ]; then echo "已生成，跳过：$name"; continue; fi
  i=$((i+1)); LAB_PORT=$((5290+i)) node scripts/e2e-gen.mjs "$name" "$f" --n "$N" --template "$TPL" > "logs/e2e-gen-$name.log" 2>&1 &
  [ $((i % 3)) -eq 0 ] && wait
done
wait
echo "生成完成：$IDS"
LAB_PORT=5231 node scripts/agent.mjs "$VER" $IDS > "logs/e2e-agent-$VER.log" 2>&1
LAB_PORT=5270 node scripts/judge.mjs e2e "agent/$VER" -- $IDS > "logs/e2e-judge-$VER.log" 2>&1
grep -h "majority" "logs/e2e-judge-$VER.log" || true
node scripts/cost-report.mjs "$VER"
