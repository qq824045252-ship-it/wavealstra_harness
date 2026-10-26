const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyPackagedApp, formatReport } = require('./verify-packaged-app.cjs');

/**
 * electron-builder afterPack hook（平台无关，Windows/Linux 共用）。
 *
 * 1) Payload gate：**所有平台都跑**。一个 unpacked 树不完整的安装包绝不能被产出/接受
 *    （校验逻辑见 scripts/verify-packaged-app.cjs）。dev 模式永远有这些文件，只有这一步
 *    能抓住坏安装包。Linux 用无扩展名主程序 + 同一个 node worker 探针。
 * 2) Windows-only：把打包 payload 的完整性级别设为 Medium（icacls）。工作区可能继承
 *    Low integrity，Windows 会以 Low 启动 EXE，Chromium 主进程无法创建 sandbox window
 *    station。只在 Windows 宿主 + win32 目标上执行。
 */
module.exports = async function afterPack(context) {
  const outDir = fs.realpathSync(context.outDir);
  const appOutDir = fs.realpathSync(context.appOutDir);
  const relative = path.relative(outDir, appOutDir);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Refusing to change integrity labels outside the packaged application directory');
  }

  const verification = verifyPackagedApp(appOutDir, { platform: context.electronPlatformName });
  console.log(formatReport(appOutDir, verification));
  if (!verification.ok) {
    throw new Error(
      'Packaged payload is incomplete: the Pi subagent runtime cannot start from this build. ' +
        'Fix the build (do not accept or install this package).\n' +
        verification.errors.map((error) => '  - ' + error).join('\n'),
    );
  }

  if (context.electronPlatformName !== 'win32' || process.platform !== 'win32') {
    console.log(
      `[packaging] payload gate passed for ${context.electronPlatformName} (host ${process.platform}); ` +
        'Windows integrity labelling skipped',
    );
    return;
  }

  const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  const result = execFileSync(icacls, [appOutDir, '/setintegritylevel', '(OI)(CI)M', '/L', '/Q'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
  console.log(`[packaging] Windows payload integrity set to Medium: ${appOutDir}\n${result.trim()}`);
};
