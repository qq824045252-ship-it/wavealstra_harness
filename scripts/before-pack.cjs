const { execFileSync } = require('node:child_process');
const path = require('node:path');
module.exports = async function beforePack(context) {
  execFileSync(process.execPath, [path.join(__dirname, 'prepare-craft-office.cjs')], {
    stdio: 'inherit', windowsHide: true, timeout: 600000,
  });
  const platform = context.electronPlatformName;
  if (platform === 'win32' || platform === 'linux') {
    const target = platform === 'win32' ? 'win-x64' : 'linux-x64';
    execFileSync(process.execPath, [path.join(__dirname, 'prepare-cadcraft.cjs'), '--target', target], {
      stdio: 'inherit', windowsHide: true, timeout: 600000,
    });
  }
};
