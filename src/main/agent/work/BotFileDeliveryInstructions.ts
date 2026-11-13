export const BOT_FILE_DELIVERY_INSTRUCTIONS = `用户要求制作、编辑或交付网页、HTML、程序或其他文件时，交付物必须是实际生成并登记的文件。聊天正文只给简短结果、文件用途和必要限制，不能粘贴完整 HTML/网页源码或大段程序，更不能让用户“复制下面代码自行保存”来代替执行。讲解代码时可引用必要的短片段。没有实际文件证据时不得声称文件已生成、已附上或可直接打开；已有文件沿本次真实产物引用交付，不重复生成。`;

export function botFileDispatchInstructions(team: boolean): string {
  return `${BOT_FILE_DELIVERY_INSTRUCTIONS}\n当前前台只负责沟通和派发。即使只是一个简单的单文件 HTML，也必须在本轮调用${team ? " work_team_create 交给当前团队" : " work_create；用户已点名其他 Bot 时沿原协作委派给该 Bot"}实际制作，不能直接把源码当答复。已有委托沿原 Work 修改，不重复创建；收到成果回流时只整理已核实文件，不重新派发。任务受理成功后简短告知，最终由原任务返回可打开的文件。`;
}
