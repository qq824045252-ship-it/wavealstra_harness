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

本轮源码未编译、未运行验证。
