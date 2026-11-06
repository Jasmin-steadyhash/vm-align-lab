# vm-align-lab

一键对齐实验台：本机跑对齐、打分。代码直接用 ava-studio 的 `client/src`、`shared`、`node_modules` 和 `.dev.vars`。

## 目录约定

- ava-studio 默认在本仓库同级（`../ava-studio`）；别的位置用环境变量 `AVA_STUDIO_DIR` 指定。
- `results/`、`logs/`、`data/`、`model-bench/results/`、`model-bench/questions/` 是运行产物和本机数据，不进仓库。

## 运行记录与复现

`scripts/agent.mjs` 每跑一个项目，在结果目录写 `run.json`：本仓库和 ava-studio 各自的提交号、实际生效的配置；
哪边有未提交改动（含未跟踪的新文件），就把改动存成同目录的 `lab.patch` / `ava-studio.patch`。

复现某次运行：

1. 本仓库：`git worktree add <目录> <run.json 里 lab.commit>`，有 `lab.patch` 就在里面 `git apply`。
2. ava-studio：同样按 `avaStudio.commit` 建 worktree，有 `ava-studio.patch` 就打上。
3. 在第 1 步的目录里用 `AVA_STUDIO_DIR=<第 2 步的目录>` 跑同样的命令（`run.json` 的 `argv`、`env`）；`data/` 需要拷或链接过去。

模型输出本身有随机性，复现的是代码和配置，结果只能统计上接近。
