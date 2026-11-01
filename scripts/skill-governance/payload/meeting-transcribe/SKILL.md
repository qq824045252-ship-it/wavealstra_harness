---
name: meeting-transcribe
description: 通过受管 speech_to_text 转写录音并生成有事实依据的会议纪要。
---
# 会议转写与纪要

1. 将用户授权的录音放入任务目录。调用 `speech_to_text(audio_path, language?, prompt?)`；必须使用用户所选 provider，不自行启动脚本、端口或切换云服务。
2. HTTP 首版仅 PCM WAV，≤10 MiB、≤120 秒。不支持长会议切片、转码、实时录音或麦克风采集；超限先说明阻塞。local provider 的依赖由能力检查报告。
3. 将工具返回的原始 text/segments/language 保存到任务目录 transcript.json；语言未知保持空缺。人名、数字、日期和责任人对照原音或用户材料核验，听不清标待确认，不补造。
4. 生成 minutes.md：主题、结论、行动项（责任人/期限）、分歧、待核实项。纪要每项可追溯到转写片段。
5. 从磁盘回读两份文件，核对关键实体与数字，交付路径及未验证项。失败不声称转写完成；不以配置检查代替实际转写。
