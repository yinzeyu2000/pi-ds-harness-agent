# M5 插件 SDK 与组合配置开发交接

日期：2026-09-03

## 结果

M5 已完成统一插件入口与静态组合闭环。第三方插件只需要导入 `@pi-ds/harness-runtime/plugin-sdk`，测试辅助能力从 `@pi-ds/harness-runtime/testing` 导入；内部 `PluginHost` 不属于第三方 SDK 的必需入口。

仓库提供两个已解析 Profile：

- `minimal.resolved.json`：内存 Session、Tool Catalog、Prompt、Models 与 Agent Driver；
- `coding.resolved.json`：以显式 `replace` 将内存 Session 替换为 JSONL，并声明 Coding Tools、Skills、Compaction、Approval、Telemetry、旧 Extension 和 UI 的依赖图；尚未接线的能力保持 disabled。

Coding Profile 在 M5 是静态、可校验的产品组合契约。文件工具和 CLI/TUI 等真实产品接线仍属于 M6，避免在配置层提前建立第二套运行时。

## 关键约束

- Service 默认禁止重复提供；manifest 校验会报告冲突和缺失依赖。
- 更换资源所有者必须使用 Profile 的显式原子 `replace` Patch，旧插件不会残留在解析结果中。
- Profile 配置必须是有限 JSON；函数、循环引用、非有限数字等不会进入 resolved manifest。
- Pi 旧 Extension 适配器位于 Coding Agent 包内，Plugin Scope 是唯一上层所有者；释放 Scope 会调用旧 Runtime 的 `invalidate()` 并清空 Event Bus。
- conformance kit 会检查 manifest 基本字段、激活、声明 Service、重复释放和 Scope 泄漏。

## 主要入口

- Public SDK：`packages/harness-runtime/src/plugin-sdk.ts`
- Conformance kit：`packages/harness-runtime/src/testing/plugin-conformance.ts`
- Manifest 解析与校验：`packages/harness-runtime/src/resolved-manifest.ts`
- Minimal/Coding Profile：`packages/harness-runtime/src/minimal-runtime.ts`、`packages/harness-runtime/src/coding-profile.ts`
- 旧 Extension 适配器：`packages/coding-agent/src/core/extensions/harness-adapter.ts`
- 检查命令：`npm run check:resolved-manifest`

## 验证

- Harness Runtime：9 个测试文件、51 个测试通过。
- 旧 Extension 适配器：2 个生命周期与回滚测试通过。
- minimal/coding 两份 checked-in manifest 均与代码解析结果一致，并通过命令行校验。
- 仓库格式、依赖固定、导入规则、锁文件、TypeScript 与浏览器 smoke 检查通过；浏览器检查因需要遍历构建输入路径而在正常本地权限下执行。

## M6 起点

按 Coding Profile 的依赖图逐项接入真实插件，建议顺序为 JSONL Session → Coding Tools → Skills/Compaction → Approval/Telemetry → CLI/TUI。每接入一项都应保持 Session Log 为唯一事实源，并用 Projection 驱动界面状态。
