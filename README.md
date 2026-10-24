# 刚好 · 净省凑单

[![CI](https://github.com/qq1906198507-ai/aitb/actions/workflows/ci.yml/badge.svg)](https://github.com/qq1906198507-ai/aitb/actions/workflows/ci.yml)

普陀创新挑战赛「AI 智能省钱场景，帮助用户更合理地充分使用平台优惠」参赛项目。针对外卖结算时「差一点到起送价」「差一点享受满减」的凑单决策问题，提供带约束的实时净省计算服务与可现场运行的产品原型。

**不劝你多买，只帮你少花。**

## 仓库结构

| 位置 | 内容 |
| --- | --- |
| `prototype/` | 产品原型：后端计价引擎（Node 20+，仅依赖 Express/CORS）与六个演示页面 |
| `prototype/docs/` | 技术方案、算法模型、可复现实验报告 |
| `output/` | 需求对齐核查、v1.4 需求补齐记录、任务评估验收、演示截图与导出数据 |
| `*.pptx` | 产品 BP（科技白版 v1.4 / 美化版 v1.4 / 历史版本） |

## 快速启动

需要 Node.js 20+。

```bash
cd prototype/backend
npm install
npm start          # http://127.0.0.1:3000/ 打开演示中心
npm test           # 64 项单元/前端测试 + API 集成测试
```

演示中心一页切换六个视图：联动体验、实时看板、操作记录、本地任务评估、PC 与移动端基础原型。宽屏时联动体验与数据看板自动并排。

## 当前版本 v1.4

- 净省推荐与起送补单双分支，完整计价（满减、券叠加/互斥、限时价、配送、包装费，按分计算）
- 「符合我的偏好」演示级排序：按本机演示事件中的品类权重微调方案次序（不改变方案内容与金额）
- 看板「起送转化（不可下单→可下单）」口径、实时计算耗时展示
- 数据边界：本机演示，不代表真实订单、支付或用户收益；业务效果验证路径见技术方案第 8 节

## 文档索引

- [使用、接口与数据口径](prototype/README.md)
- [需求对齐核查 v1.4](output/需求对齐核查_v1.4_20261024.md)
- [v1.4 需求补齐记录](output/需求补齐记录_v1.4_20261024.md)
- [技术方案](prototype/docs/TECHNICAL_SOLUTION.md) · [算法模型](prototype/docs/ALGORITHM_MODEL.md) · [实验报告](prototype/docs/EXPERIMENT_REPORT.md)
