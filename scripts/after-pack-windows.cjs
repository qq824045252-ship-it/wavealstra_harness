const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

module.exports = async function afterPackWindows(context) {
  if (process.platform !== 'win32' || context.electronPlatformName !== 'win32') return;

  const outDir = fs.realpathSync(context.outDir);
  const appOutDir = fs.realpathSync(context.appOutDir);
  const relative = path.relative(outDir, appOutDir);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Refusing to change integrity labels outside the packaged application directory');
  }

  // A workspace may inherit Low integrity. Windows then starts its EXE at Low,
  // preventing Chromium's main process from creating its sandbox window station.
  // Label only the packaged payload, preserving the workspace and all DACLs.
  const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  const result = execFileSync(icacls, [appOutDir, '/setintegritylevel', '(OI)(CI)M', '/L', '/Q'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
  console.log(`[packaging] Windows payload integrity set to Medium: ${appOutDir}\n${result.trim()}`);
};
