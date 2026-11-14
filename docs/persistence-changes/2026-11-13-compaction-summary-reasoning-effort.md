---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-13-compaction-summary-reasoning-effort

English | [中文](2026-11-13-compaction-summary-reasoning-effort.zh.md)

## Summary

Adds optional reasoningEffort to compaction/summary, recording the reasoning effort the summarization call sent.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid: the property is optional, and its absence means the effort was not recorded, not that the call ran without one. The backend writes it only when the summarization call inherited an effort from the routed request header. No reader in this repository consumes the property; the token-meter projections, conversation and trajectory views, statistics, and log export read other summary fields and do not validate the payload against a closed property set, so earlier readers load the record unchanged. Session format version remains unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/compaction/compaction-basic/tests/prefix-cache-integrity.spec.ts -t "replays the routed reasoning effort in the summary call": 1 test passed. It compares the recorded value of every compaction/summary event with the routed effort.

<a id="dev-note"></a>
## Dev Note

None.
