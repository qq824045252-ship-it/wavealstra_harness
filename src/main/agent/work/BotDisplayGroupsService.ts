import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { botDisplayGroupCommand, type BotDisplayGroups } from '../../../shared/bot-display-groups';
/** Display metadata only: never mutates Bots, Work, authorization, cwd or conversation state. */
export class BotDisplayGroupsService {
 constructor(private db: Database.Database, private userId: string) {
  db.exec(`CREATE TABLE IF NOT EXISTS bot_display_groups(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,collapsed INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS bot_display_groups_name ON bot_display_groups(user_id,name COLLATE NOCASE);
   CREATE TABLE IF NOT EXISTS bot_display_group_members(bot_id TEXT PRIMARY KEY REFERENCES bots(bot_id) ON DELETE CASCADE,group_id TEXT NOT NULL REFERENCES bot_display_groups(id) ON DELETE CASCADE);`);
 }
 execute(input: unknown): BotDisplayGroups {
  const c=botDisplayGroupCommand.parse(input);
  return this.db.transaction(()=>{
   const group=(id:string)=>{if(!this.db.prepare('SELECT 1 FROM bot_display_groups WHERE id=? AND user_id=?').get(id,this.userId))throw new Error('分组不存在');};
   const bot=(id:string)=>{if(!this.db.prepare('SELECT 1 FROM bots WHERE bot_id=? AND user_id=?').get(id,this.userId))throw new Error('Bot 不属于当前用户');};
   const name=(value:string,id='')=>{if(value==='未分组')throw new Error('请使用其他分组名称');if(this.db.prepare('SELECT 1 FROM bot_display_groups WHERE user_id=? AND name=? COLLATE NOCASE AND id<>?').get(this.userId,value,id))throw new Error('分组名称已存在');};
   if(c.kind==='create'){name(c.name);if(c.botId)bot(c.botId);const id=randomUUID();this.db.prepare('INSERT INTO bot_display_groups VALUES(?,?,?,0,?)').run(id,this.userId,c.name,Date.now());if(c.botId)this.db.prepare('INSERT INTO bot_display_group_members VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET group_id=excluded.group_id').run(c.botId,id);}
   if(c.kind==='rename'){group(c.id);name(c.name,c.id);this.db.prepare('UPDATE bot_display_groups SET name=? WHERE id=?').run(c.name,c.id);}
   if(c.kind==='delete'){group(c.id);this.db.prepare('DELETE FROM bot_display_group_members WHERE group_id=?').run(c.id);this.db.prepare('DELETE FROM bot_display_groups WHERE id=?').run(c.id);}
   if(c.kind==='collapse'){group(c.id);this.db.prepare('UPDATE bot_display_groups SET collapsed=? WHERE id=?').run(Number(c.collapsed),c.id);}
   if(c.kind==='move'){bot(c.botId);if(c.groupId){group(c.groupId);this.db.prepare('INSERT INTO bot_display_group_members VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET group_id=excluded.group_id').run(c.botId,c.groupId);}else this.db.prepare('DELETE FROM bot_display_group_members WHERE bot_id=?').run(c.botId);}
   const groups=this.db.prepare('SELECT id,name,collapsed FROM bot_display_groups WHERE user_id=? ORDER BY created_at,id').all(this.userId) as {id:string;name:string;collapsed:number}[];
   const members=this.db.prepare('SELECT m.bot_id,m.group_id FROM bot_display_group_members m JOIN bots b ON b.bot_id=m.bot_id JOIN bot_display_groups g ON g.id=m.group_id WHERE b.user_id=? AND g.user_id=?').all(this.userId,this.userId) as {bot_id:string;group_id:string}[];
   return {groups:groups.map(g=>({...g,collapsed:!!g.collapsed})),membership:Object.fromEntries(members.map(m=>[m.bot_id,m.group_id]))};
  }).immediate();
 }
}
