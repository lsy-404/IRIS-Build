# Findings

- 中心 `runner/contract.mjs` 的 Windows schema 使用 `stage: windows_sign`，`project_id`、源码 SHA、版本、`x64`、输入摘要、Azure 证书身份和 Windows recipe 均进入 manifest；verification 必须声明 Authenticode、timestamp 和 `nested_signatures_verified`。
- Windows project 由父任务指定为 `iris-shell-windows-x64`，源 workflow 的 required job 必须精确命名为 `shell-build-windows`。
- 中心公开 response 保持 `output.archive_digest/archive_size/report`，最终归档走 `/v1/requests/:id/download`。
- 当前发布上下文严格绑定两份 macOS 请求；增加 Windows 请求需扩展 sealed context，不能把请求信息只放在未校验 job output。
- `app-builder blockmap --input <file> --output <file>.blockmap` 是 electron-builder 使用的上游工具形式；重签之后需针对最终 installer 重新计算 blockmap 与 SHA-512。

- 初次运行相关发布测试时，旧 fixture 仍按双 macOS 请求构造上下文，导致 26 项失败；仅调整现有 fixture 和既有发布清单断言适配三请求契约，没有添加测试用例。调整后 76 项相关 Node 测试全过。
- 既有静态 workflow 检查原本要求 Windows 仍在 unsigned installer matrix，更新为 Linux matrix + 独立 `shell-build-windows`，并断言发布依赖 Windows 原生验签 job。
- 当前环境未执行 GitHub Windows runner、签名中心服务或实际签名归档；Windows Authenticode 与 app-builder 的真实执行需由集成发布流程验证。

- 主任务审阅发现 finalize 的 Hash.digest 重复调用会抛出 ERR_CRYPTO_HASH_FINALIZED，已改为一次取出字节并编码为 hex/base64；证书 DN 比较按属性归一化，保留完整主体校验。

- 昨日未发布 0.5.90 的 publisher 在 dmg-staple 阶段退出。为已有原生票据校验加入三次有限重试，全部失败仍拒绝发布；签名、Team、Gatekeeper 和装订要求不变。旧上下文保存后由本轮完整签名 0.6.0 取代。
