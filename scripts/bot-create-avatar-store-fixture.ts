import {create} from "zustand";
import type {BotCreateRequest,BotCreateResult} from "../src/shared/bot-create";
export const requests:BotCreateRequest[]=[];
export let respond!:(result:BotCreateResult)=>void;
export let fail!:(error:Error)=>void;
export const useAppStore=create<any>((set)=>({botIdentities:[],page:"bot",activeBotId:"old",selectedWorkId:null,activeTaskId:null,setActiveBotId:(id:string)=>set({activeBotId:id}),setPage:(page:string)=>set({page}),createBot:async(request:BotCreateRequest)=>{requests.push(structuredClone(request));return new Promise<BotCreateResult>((resolve,reject)=>{respond=resolve;fail=reject;});}}));
