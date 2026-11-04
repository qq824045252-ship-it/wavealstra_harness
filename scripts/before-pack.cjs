const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { Arch } = require('electron-builder');

module.exports = async function beforePack(context) {
  const key = `${context.electronPlatformName}-${Arch[context.arch]}`;
  execFileSync(process.execPath, [path.join(__dirname, 'prepare-officecli.cjs'), key], {
    stdio: 'inherit', windowsHide: true, timeout: 300000,
  });
};
