---
name: npu-ocr
description: 使用受管 ocr_file 识别任务内 PNG/JPEG 文字。保留技能 ID；不声称 NPU 或原 CLI 全功能。
---
# 图片 OCR

调用 `ocr_file(image_path)`，图片必须在任务目录，≤10 MiB。使用能力设置中明确绑定的服务，不自行安装、调用个人 exe 或切换云服务。失败报告具体阻塞。

把返回结果保存为 ocr.json，再从磁盘回读；逐一核对中文、人名、表格数字和小数点。不确定或缺失字段标待核实。返回框坐标是输入图片像素；无框或 confidence 缺失代表 unknown，不伪造满分。

支持范围：PNG/JPEG → text + 可选真实 boxes。PDF 分页、Office 文档、版面阅读顺序、旋转校正、窗口 OCR 与坐标点击尚未接入。项目资料导入不自动 OCR/上传。需要窗口操作时使用既有 computer_exec 平台观察链，不能拿文件 OCR 的框直接点击桌面；Wayland 后台截图限制不因 HTTP 服务而改变。
