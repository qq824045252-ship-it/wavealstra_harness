/** Synthetic process fixture. It has no credentials/network and rejects every write. */
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), home = process.env.HOME;
fs.appendFileSync(path.join(home, 'gws-calls.jsonl'), JSON.stringify(args) + '\n');
if (args[0] === '--help') { console.log('Google Workspace CLI cal gmail'); process.exit(0); }
if (fs.existsSync(path.join(home, 'gws-auth-failure'))) { console.error('invalid_grant: Token has been expired or revoked.'); process.exit(1); }
if (args[0] === 'gmail' && args[1] === 'search') {
  if (args.includes('--json')) console.log(JSON.stringify([{id:'mail731'}]));
  else console.log('约 1 条匹配，显示前 1 条：\n- Wed, 11 Nov 2026 09:00:00 +0800\n  发件: Alice <alice@example.test>\n  主题: 合同确认 CONTRACT_731\n  id=mail731  (未读)');
} else if (args[0] === 'gmail' && args[1] === 'read') {
  console.log('发件: Alice <alice@example.test> | 日期: 2026-11-11\n主题: 合同确认 CONTRACT_731\n' + '-'.repeat(40) + '\n请在星期五前核对合同，预算为731元。正文标记 BODY_731。\n<img src="https://tracker.invalid/pixel"><script>window.untrustedMailRan=true</script>');
} else if (args[0] === 'cal' && args[1] === 'agenda') {
  console.log(JSON.stringify([{id:'evt731',summary:'项目同步 CAL_731',start:{dateTime:'2026-11-12T09:00:00+08:00'},end:{dateTime:'2026-11-12T10:00:00+08:00'},location:'线上会议'}, {id:'holiday731',summary:'全天安排 ALL_DAY_731',start:{date:'2026-11-13'},end:{date:'2026-11-14'}}]));
} else { console.error('Fixture forbids unsupported or write command'); process.exit(70); }
