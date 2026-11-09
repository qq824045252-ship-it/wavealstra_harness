# 工具结果核验

Durable 保存工具完成结果并决定安全重放。MyBuddy 在工具开始前保存核验意图，恢复时只读取实际状态，不重发结果未知的副作用。

原生 `write` 保存预期 UTF-8 字节数、SHA-256 和规范路径。原生 `edit` 只对能确定结果的唯一、不重叠精确替换保存预期哈希；模糊匹配不能推测结果。完成或中断恢复后回读目标文件。只核验普通文件，先比对长度，再限制读取字节及时间并响应取消；读取前后核对文件身份。路径变化、内容不同、文件不可读都保留未确认状态。

MCP 工具可在服务器提供的工具定义中显式声明业务回执契约，模型参数不能修改该契约：

```json
{
  "_meta": {
    "mybuddy/recovery": {
      "version": 1,
      "idempotencyArgument": "operation_id",
      "receiptTool": "get_operation_status",
      "receiptArgument": "operation_id",
      "operationIdField": "operation_id",
      "statusField": "status",
      "completedValues": ["completed"],
      "failedValues": ["failed"]
    }
  }
}
```

两个参数都必须存在于各工具的输入 schema 且为字符串。查询工具必须属于同一个已启用服务器、当前可见，声明 `readOnlyHint: true`，名称与参数也须通过只读分类，不能是写文件或危险工具。宿主根据持久执行身份生成幂等键并注入原请求。回执查询只传该身份，必须返回 `structuredContent`，并回显完全相同的操作 ID。

只读回执核验成功时，中断结果可变成已确认的成功结果供原生执行继续；不会再次调用副作用工具。服务器连接配置指纹变化、契约变化、查询未授权、查询超时、身份不符、仍在处理中或没有契约的工具均不自动确认或重发。现有执行记录保存核验器、预期、观测和检查时间。服务端必须实际落实幂等键语义；本地记录不能让任意外部系统获得事务性。

## 失败与未知结果的统一处理

- 正常返回的错误是普通工具失败，不再升级为 Work 硬阻塞。原生 bash/PowerShell 的结构化 `exitCode`、`exit_code` 诊断覆盖所有命令，不按命令内容增加白名单。失败保留失败状态；非零退出不能证明此前没有部分写入。
- 超时、断连、宿主中断和回执核验不确定仍记为未知。按强制继续策略，它们保留原操作身份和诊断，不冻结其他步骤、整个 Work 的恢复或收尾，不提供成功或验收证据。
- 工具效果未知与原执行是否仍在运行分开：仅状态回读失败不等于进程结束，保留原生执行在途状态。原执行仍可能写入时，不启动竞争执行，也不提前声称停止完成；独立 Work 和工具失败后的独立步骤仍可继续。
- 原生 unsafe replay 防护、工具审批、只读范围、目录边界和通知发送去重不变。恢复输入带原未知 operation ID，先核对回执/目标状态，不盲目重发。
- 旧 external-effect blocker 转为带 `continue_without_replay` 的非阻塞诊断并保留原始审计。只有准确匹配宿主持久身份与已返回失败证据的 unknown admission 才转为 consumed；孤立 admitted 转为真实 unknown。迁移幂等，不提升 schema，不删除用户业务数据。

验证入口：`test:durable-tool-policy`（真实进程、普通/Code Mode/子代理、六并发、超时与重启不重放）、`test:work-effect-retirement`（历史证据与权限不变、幂等）、Work 恢复及控制测试。真实桌面和公网模型验收另行记录，不能由 fixture 通过代替。
