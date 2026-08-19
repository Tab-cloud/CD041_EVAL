# Windows 发布签名

## 当前信任链

- 新发布基线：`0.1.0`
- 活动 Minisign/Tauri key ID：`B7E3D244CA9DFBE4`
- 活动凭据目录：`%LOCALAPPDATA%\Eval\release-signing`
- 客户端内置公钥：`app/src-tauri/tauri.conf.json`
- 正式发布命令：`pwsh -NoProfile -File .\scripts\package-windows-release.ps1`

旧 key ID `B17930B6F46C1AFF` 保存在 `legacy-0.1.x-20260815` 只读归档中，不再用于新发布。新 `0.1.0` 使用新的公钥，因此旧安装版本不能通过自动更新进入这条信任链；需要人工安装新 `0.1.0`，之后再通过正常版本递增完成自动升级。

## 凭据边界

活动目录只允许当前 Windows 用户和 `SYSTEM` 访问，并关闭 ACL 继承：

- `updater.key`：由随机强密码加密的活动私钥。
- `updater.password.dpapi`：使用 Windows DPAPI `CurrentUser` 保护的私钥密码。
- `updater.pub`：活动公钥，只在首次配置或批准的密钥轮换时提供给 Web。
- `key-metadata.json`：key ID、公钥 SHA-256、基线版本和归档位置，不包含密码或私钥内容。

私钥、密码和 DPAPI 文件不得进入 Git、`dist`、聊天、终端日志、CI 制品或 Web。`dist\<version>` 只允许包含 EXE、对应 `.sig` 和 SHA-256 校验文件。

## 正式打包

发布脚本执行以下保护：

1. 校验凭据目录位于仓库之外且 ACL 已关闭继承。
2. 校验只有当前 Windows 用户和 `SYSTEM` 拥有访问权。
3. 校验 `package.json`、`Cargo.toml` 和 `tauri.conf.json` 版本一致。
4. 校验受保护的 `updater.pub` 与客户端内置公钥一致。
5. 在当前用户进程内通过 DPAPI 解密密码，不输出密码。
6. 生产构建 NSIS EXE，并用活动私钥生成 `.sig`。
7. 将 EXE、`.sig` 和 SHA-256 写入 `D:\Projects\CD041_LUBAN\dist\<version>`。
8. 清除进程级签名环境变量和内存中的密码字节。

## Web 发布

首次配置新信任链时，在 Web 管理端保存活动 `updater.pub` 的完整内容。之后每个版本只上传：

- `Eval_<version>_x64-setup.exe`
- `Eval_<version>_x64-setup.exe.sig`

`.sha256.key` 用于本地归档和人工校验，不上传；Web 会重新计算 SHA-256。发布版本必须与安装包内部版本完全一致。

## 轮换与事件处理

只有私钥确认泄露、密码进入日志、受保护存储损坏或管理员明确批准时才允许轮换。轮换必须同时完成：

1. 撤销未发布的候选密钥和签名产物。
2. 生成新的加密私钥和随机密码，并使用 DPAPI 保存密码。
3. 更新客户端内置公钥并重新构建安装包。
4. 独立验证 `.sig`、版本、SHA-256 和安装内容。
5. 在 Web 管理端切换公钥后，再上传和发布新制品。
6. 将旧密钥移入受保护的只读归档，并记录 key ID 和退役原因。

不得通过关闭 Web 验签、上传无签名 EXE或把私钥放入部署环境来绕过发布边界。
