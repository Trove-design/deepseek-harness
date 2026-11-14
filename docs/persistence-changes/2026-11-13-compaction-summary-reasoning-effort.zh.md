---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-13-compaction-summary-reasoning-effort

[English](2026-11-13-compaction-summary-reasoning-effort.md) | 中文

## 概述

为 compaction/summary 增加可选的 reasoningEffort，记录摘要调用实际发送的推理强度。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-13-compaction-summary-reasoning-effort
baseline: false
changes:
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "8cd2f19c03f77ae26dcd90dd62951c19d425a1a88f6695ff51372b7e9c117747"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效：该属性可选，缺失表示未记录推理强度，不表示调用未携带推理强度。后端仅在摘要调用从已路由的请求头继承了推理强度时写入。本仓库没有读取方消费该属性；token-meter 投影、对话与轨迹视图、统计和日志导出读取摘要的其他字段，且不按封闭属性集校验载荷，因此旧版读取方可原样加载该记录。Session 格式版本保持不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/compaction/compaction-basic/tests/prefix-cache-integrity.spec.ts -t "replays the routed reasoning effort in the summary call"：1 个测试通过。该测试将每个 compaction/summary 事件记录的值与路由的推理强度逐一比较。

<a id="dev-note"></a>
## 开发备注

无。
