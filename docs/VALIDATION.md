# 验证范围

运行 `npm run check` 执行类型检查、构建和测试。当前保留 10 个测试文件、36 个用例，使用隔离的临时配置与本地模拟 DSH 进程，不消耗真实模型额度。

覆盖项目显式启用和会话隔离、任务生命周期与排队、模型档位和设置持久化、profile 模型迁移、消息分页与工具结果显示。模型发现还使用本机 DSH 0.2.1-rc.2 的只读探测，确认 `contextWindow`、`input` 和 `reasoningEfforts` 来自 DSH 解析后的模型信息。

安装包由 `npm run pack:plugin` 生成；`release/SHA256SUMS` 可校验 ZIP。已在独立临时 `CODEX_HOME` 中验证安装、项目启用、缓存校验与卸载；真实 Codex 面板交互和任务回传仍以目标宿主验收为准。仓库不包含用户的 DSH profile、凭据、运行数据或本机安装缓存。
