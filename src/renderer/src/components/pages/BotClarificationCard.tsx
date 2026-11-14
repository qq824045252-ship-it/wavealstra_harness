import { botClarificationAnswerText, botClarificationAnswerRequestId } from "@shared/bot-conversation";
import { useState } from "react";
import type { BotMessageDto, BotClarificationDto } from "@shared/bot-conversation";
import { ConversationInteractionCard } from "../chat/ConversationRuntimeCards";
import { useAppStore } from "@/store/appStore";

/** A referenced ordinary reply, not a synthetic Task or a global active-conversation mutation. */
export function BotClarificationCard({message}:{message:BotMessageDto}):React.JSX.Element|null {
  return <>{message.clarifications?.map(card=><BotClarificationItem key={card.goalId} message={message} card={card}/>)}</>;
}
function BotClarificationItem({message,card}:{message:BotMessageDto;card:BotClarificationDto}):React.JSX.Element|null {
  const [dismissed,setDismissed]=useState(false);
  const [sent,setSent]=useState(false);
  if(!card || dismissed)return null;
  return <ConversationInteractionCard answerDisplayText={card.answerText} interaction={{id:card.goalId,taskId:"",executionId:message.requestId,
    description:card.status==="expired"?"团队已更换队长或已删除。为避免把旧身份的来源转交给其他 Bot，请向当前队长重新提问。":undefined,
    assistantMessageId:message.messageId,kind:"single_select",title:card.question,options:card.options,allowCustom:true,
    customPlaceholder:"也可以直接输入你的回答",status:card.status==="expired"?"expired":card.status==="cancelled"?"cancelled":card.status==="pending"&&!sent?"pending":"resolved",
    version:1,createdAt:message.createdAt}}
    onDismiss={()=>setDismissed(true)}
    onRespond={async (answer,source)=>{
      if(typeof answer!=="string" || !answer.trim())return {ok:false,message:"请选择或输入回答"};
      if(!window.api?.botWork)return {ok:false,message:"主机离线，请稍后重试"};
      const text=botClarificationAnswerText(card,answer,source);
      if(!text)return {ok:false,message:"选项已失效，请刷新"};
      const requestId=botClarificationAnswerRequestId(message.messageId,card.goalId);
      const receipt=await window.api.botWork.sendMessage({botId:message.botId,teamId:message.teamId,
        conversationId:message.conversationId,referenceMessageId:message.messageId,clarificationGoalId:card.goalId,requestId,text});
      if(receipt.requestId!==requestId || receipt.conversationId!==message.conversationId)throw Error("回答回执身份不匹配");
      setSent(true);
      await useAppStore.getState().refreshBotHistory(message.botId,message.teamId);
      return {ok:true};
    }}/>
}
