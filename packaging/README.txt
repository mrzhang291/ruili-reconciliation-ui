锐力对账系统（BillCompare）

安装目录：%LOCALAPPDATA%\Programs\BillCompare

1. 安装完成后，双击桌面的“BillCompare”图标。
2. 浏览器会自动打开 http://127.0.0.1:3333/。
3. 首次使用请先安装并授权 lark-cli profile aad27213，再在“连接设置”中填写 CherryStudio API Key。
4. 凭据由 Windows 当前用户加密保存，不会明文写入安装包。

使用前请确认：
- CherryStudio Enterprise 已安装并启动。
- CherryStudio API 服务已监听 127.0.0.1:24333。
- 已创建名为“锐力”的对账 Agent。
- 电脑可以访问业务服务器。

如需停止后台服务，请从开始菜单运行“Stop BillCompare”。
运行日志位于安装目录 app\.runtime\logs。
