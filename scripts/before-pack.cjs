const { execFileSync } = require('node:child_process');
const path = require('node:path');
module.exports = async function beforePack(context) {
  execFileSync(process.execPath, [path.join(__dirname, 'prepare-craft-office.cjs')], {
    stdio: 'inherit', windowsHide: true, timeout: 600000,
  });
};
