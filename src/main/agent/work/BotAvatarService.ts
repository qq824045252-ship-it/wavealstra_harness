import { sanitizeBotAvatarGif } from "./BotAvatarGif";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, mkdirSync, lstatSync, chmodSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { extname, join } from "node:path";
import { AVATAR_UPLOAD_BYTES, AVATAR_UPLOAD_LIMIT, builtinBotAvatars, type BotAvatarSnapshot } from "../../../shared/bot-avatar";
import { inspectAvatarRaster } from "../../../shared/bot-avatar-raster";

const uploadId = /^upload:([a-f0-9]{64})$/;
const MAX_POSTER_BYTES = 128 * 1024;
/** Local appearance only: no attachment, artifact, model context, gateway, or remote-file registration. */
export class BotAvatarService {
  constructor(private readonly db: Database.Database, private readonly userId: string, private readonly directory: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS bot_avatar_choices (
      bot_id TEXT PRIMARY KEY REFERENCES bots(bot_id) ON DELETE CASCADE, asset_id TEXT, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_avatar_uploads (user_id TEXT NOT NULL, asset_id TEXT NOT NULL, label TEXT NOT NULL,
      PRIMARY KEY(user_id,asset_id));
      CREATE TABLE IF NOT EXISTS bot_avatar_animations (user_id TEXT NOT NULL,asset_id TEXT NOT NULL,poster_hash TEXT NOT NULL,animation_hash TEXT NOT NULL,PRIMARY KEY(user_id,asset_id));
      CREATE TABLE IF NOT EXISTS bot_avatar_preferences (user_id TEXT PRIMARY KEY, motion INTEGER NOT NULL);`);
  }
  snapshot(): BotAvatarSnapshot {
    const selections: BotAvatarSnapshot["selections"] = {};
    for (const row of this.db.prepare(`SELECT c.bot_id,c.asset_id,c.revision FROM bot_avatar_choices c
      JOIN bots b ON b.bot_id=c.bot_id WHERE b.user_id=?`).all(this.userId) as Array<{bot_id:string;asset_id:string|null;revision:number}>) {
      selections[row.bot_id] = { assetId: row.asset_id && this.available(row.asset_id) ? row.asset_id : null, revision: row.revision };
    }
    const uploads = (this.db.prepare("SELECT u.asset_id id,u.label,EXISTS(SELECT 1 FROM bot_avatar_animations a WHERE a.user_id=u.user_id AND a.asset_id=u.asset_id) animated FROM bot_avatar_uploads u WHERE u.user_id=? ORDER BY u.rowid").all(this.userId) as BotAvatarSnapshot["uploads"]);
    const preference = this.db.prepare("SELECT motion FROM bot_avatar_preferences WHERE user_id=?").get(this.userId) as {motion:number}|undefined;
    return { selections, uploads: uploads.map(asset=>({...asset,animated:Boolean(asset.animated)})), motion: preference?.motion !== 0 };
  }
  private available(id: string): boolean {
    return builtinBotAvatars.some(asset => asset.id === id) || Boolean(uploadId.test(id) && this.db.prepare("SELECT 1 FROM bot_avatar_uploads WHERE user_id=? AND asset_id=?").get(this.userId,id));
  }
  set(botId: string, assetId: string | null, expectedRevision: number): BotAvatarSnapshot {
    return this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM bots WHERE bot_id=? AND user_id=?").get(botId,this.userId)) throw new Error("Bot 不属于当前用户");
      if (assetId && !this.available(assetId)) throw new Error("头像不可用，请重新选择");
      const previous = this.db.prepare("SELECT revision FROM bot_avatar_choices WHERE bot_id=?").get(botId) as {revision:number}|undefined;
      if ((previous?.revision ?? 0) !== expectedRevision) throw new Error("头像已在其他窗口更改，请刷新后重试");
      this.db.prepare(`INSERT INTO bot_avatar_choices VALUES(?,?,?) ON CONFLICT(bot_id)
        DO UPDATE SET asset_id=excluded.asset_id,revision=excluded.revision`).run(botId,assetId,expectedRevision+1);
      return this.snapshot();
    }).immediate();
  }
  motion(enabled: boolean): BotAvatarSnapshot {
    this.db.prepare("INSERT INTO bot_avatar_preferences VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET motion=excluded.motion").run(this.userId,Number(enabled));
    return this.snapshot();
  }
  private privateRoot(): string {
    // Each user has a separate directory; never follow a substituted directory symlink.
    const root = join(this.directory, createHash("sha256").update(this.userId).digest("hex"));
    for (const path of [this.directory,root]) {
      mkdirSync(path,{recursive:true,mode:0o700});
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("头像存储目录不安全");
      chmodSync(path,0o700);
    }
    return root;
  }
  private path(id: string, variant: "poster" | "animation" = "poster"): string {
    const match = uploadId.exec(id);
    if (!match) throw new Error("头像标识无效");
    return join(this.privateRoot(),`${match[1]}.${variant === "animation" ? "gif" : "png"}`);
  }
  private readBounded(path: string, limit: number): Buffer {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("请选择普通图片文件，不能使用符号链接");
    const descriptor = openSync(path,constants.O_RDONLY|constants.O_NONBLOCK|(constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(descriptor);
      if (stat.dev !== before.dev || stat.ino !== before.ino) throw new Error("文件读取时发生变化，请重新选择");
      if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new Error(`请选择有效图片，文件最大 ${limit===AVATAR_UPLOAD_BYTES ? "2 MB" : "128 KB"}`);
      const bytes = Buffer.alloc(stat.size+1);
      let length = 0;
      while (length < bytes.length) { const count=readSync(descriptor,bytes,length,bytes.length-length,null); if (!count) break; length+=count; }
      const after = fstatSync(descriptor);
      if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("文件读取时发生变化，请重新选择");
      return bytes.subarray(0,length);
    } finally { closeSync(descriptor); }
  }
  private storeFile(path: string, bytes: Buffer, repair: boolean): void {
    try {writeFileSync(path,bytes,{flag:"wx",mode:0o600});return;}
    catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    const previous=this.readBounded(path,bytes.length > MAX_POSTER_BYTES ? 1024*1024 : MAX_POSTER_BYTES);
    if(previous.equals(bytes))return;
    if(!repair)throw new Error("头像暂存文件损坏，请移除后重新添加");
    // Replace only a verified regular app-owned cache file. Rename never follows the destination.
    const temporary=`${path}.${randomUUID()}.tmp`;
    try {writeFileSync(temporary,bytes,{flag:"wx",mode:0o600});renameSync(temporary,path);}
    finally {try{unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
  }
  /** Path is supplied only by the native dialog, never accepted in renderer IPC arguments. */
  async importSelected(path: string, normalize: (bytes: Buffer) => Buffer | Promise<Buffer>, authorize: () => void): Promise<string> {
    authorize();
    const extension = extname(path).toLowerCase();
    if (![".png",".jpg",".jpeg",".gif",".webp"].includes(extension)) throw new Error("仅支持 PNG、JPEG、GIF 和静态 WebP");
    const bytes = this.readBounded(path,AVATAR_UPLOAD_BYTES);
    const metadata = inspectAvatarRaster(bytes);
    const expected = extension === ".jpg" || extension === ".jpeg" ? "jpeg" : extension.slice(1);
    if (metadata.type !== expected) throw new Error("图片扩展名与内容不一致");
    const animation = metadata.type === "gif" && metadata.frames > 1 ? sanitizeBotAvatarGif(bytes) : undefined;
    const poster = await normalize(bytes);
    const result = inspectAvatarRaster(poster);
    if (result.type !== "png" || result.frames !== 1 || result.width > 256 || result.height > 256 || poster.length > MAX_POSTER_BYTES) throw new Error("头像转换失败，请选择其他图片");
    const id = `upload:${createHash("sha256").update(poster).update(animation ?? Buffer.alloc(0)).digest("hex")}`;
    authorize();
    this.db.transaction(() => {
      const known=this.available(id);
      if (!known) {
        const count = this.db.prepare("SELECT COUNT(*) n FROM bot_avatar_uploads WHERE user_id=?").get(this.userId) as {n:number};
        if (count.n >= AVATAR_UPLOAD_LIMIT) throw new Error("本地头像最多保存 32 个，请先移除不用的头像");
      }
      this.storeFile(this.path(id),poster,known);
      if(animation)this.storeFile(this.path(id,"animation"),animation,known);
      if(!known) {
        if(animation)this.db.prepare("INSERT INTO bot_avatar_animations VALUES(?,?,?,?)").run(this.userId,id,createHash("sha256").update(poster).digest("hex"),createHash("sha256").update(animation).digest("hex"));
        this.db.prepare("INSERT INTO bot_avatar_uploads VALUES(?,?,?)").run(this.userId,id,`本地头像 ${id.slice(7,15)}`);
      }
    }).immediate();
    return id;
  }
  read(id: string, variant: "poster" | "animation" = "poster"): string {
    if (!uploadId.test(id) || !this.available(id)) throw new Error("本地头像不存在");
    const animation=this.db.prepare("SELECT poster_hash,animation_hash FROM bot_avatar_animations WHERE user_id=? AND asset_id=?").get(this.userId,id) as {poster_hash:string;animation_hash:string}|undefined;
    if(variant==="animation" && !animation)throw new Error("此头像没有动画");
    const bytes = this.readBounded(this.path(id,variant),variant==="animation" ? 1024*1024 : MAX_POSTER_BYTES);
    const expected=variant==="animation" ? animation!.animation_hash : animation?.poster_hash ?? id.slice(7);
    const type=variant==="animation" ? "gif" : "png";
    if (createHash("sha256").update(bytes).digest("hex") !== expected || inspectAvatarRaster(bytes).type !== type) throw new Error("本地头像损坏，请重新添加");
    return `data:image/${type};base64,${bytes.toString("base64")}`;
  }
  remove(id: string): BotAvatarSnapshot {
    if (!uploadId.test(id) || !this.available(id)) throw new Error("本地头像不存在");
    // Compute before deleting the metadata. Failed IO leaves the choice visible and retryable.
    const path = this.path(id);
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {unlinkSync(this.path(id,"animation"));} catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    this.db.transaction(() => {
      this.db.prepare(`UPDATE bot_avatar_choices SET asset_id=NULL,revision=revision+1 WHERE asset_id=?
        AND bot_id IN (SELECT bot_id FROM bots WHERE user_id=?)`).run(id,this.userId);
      this.db.prepare("DELETE FROM bot_avatar_animations WHERE user_id=? AND asset_id=?").run(this.userId,id);
      this.db.prepare("DELETE FROM bot_avatar_uploads WHERE user_id=? AND asset_id=?").run(this.userId,id);
    }).immediate();
    return this.snapshot();
  }
}
