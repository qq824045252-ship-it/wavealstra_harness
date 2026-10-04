# Installation and connector setup

> **本 skill 单独装上没用 —— 它要驱动两个外部件:本机 `easyeda` CLI/daemon + EasyEDA Pro 里的连接器插件。**
> 源码与文档:https://github.com/zhoushoujianwork/easyeda-agent
>
> **① 装 CLI/daemon**(一行,自动识别平台;已装过则用 `easyeda update` 升级):
> ```
> curl -fsSL https://raw.githubusercontent.com/zhoushoujianwork/easyeda-agent/main/install.sh | sh
> ```
>
> **② 装连接器插件(`.eext`)—— 二选一,都要在 EasyEDA Pro 里操作:**
> - **立创EDA官方插件市场**(推荐,一键装、平台可原地自动更新):
>   https://jlc-ext.com/item/zhoushoujian/easyeda-agent-connector
>   ⚠ 市场版本可能**滞后** CLI 若干 minor。
> - **GitHub Release 直下**(与 CLI **严格同版**,四件套同版以它为准):
>   https://github.com/zhoushoujianwork/easyeda-agent/releases/latest
>   下载其中的 `easyeda-agent-connector.eext` → EasyEDA 扩展管理导入。
>   **同 uuid 更新必须先在「已安装」卸载旧的**,否则导入静默失败;导入后**完全退出重启
>   EasyEDA**,否则已开窗口仍跑旧代码并抢 daemon。
>
> **③ 开权限**:EasyEDA 里打开工程 → 启用「允许外部交互 / Allow external interaction」,
> 否则连接器的 WebSocket 到不了 daemon。装完用 `easyeda health` 验证(应看到 window 与
> connectorVersion)。
>
> **升级:`easyeda update`**(CLI 二进制 + skill 目录,sha256 校验后原地替换);
> `easyeda update --check` 只看不改,连接器只能人工重装 → environment-setup.md §0.5。
