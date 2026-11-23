const fs = require('node:fs');
const path = require('node:path');
const { finishDesktopCheck } = require('./desktop-dev-harness.cjs');
const { assertDesktopCase, fingerprintFiles, verifyDesktopCases } = require('./desktop-verification.cjs');

async function main() {
  const root = process.cwd();
  const caseId = process.argv[2];
  const launches = path.join(root, 'launches.txt');
  const result = await verifyDesktopCases({ caseIds: [caseId], fresh: process.argv.includes('--fresh'),
    fingerprint: () => fingerprintFiles(root, ['fixture-layout.txt']), receiptsDirectory: path.join(root, 'receipts'),
    run: async () => {
      fs.appendFileSync(launches, `${caseId}\n`);
      const value = fs.readFileSync('fixture-layout.txt', 'utf8').trim();
      const report = { status: 'passed' };
      const reportPath = path.join(root, `report-${fs.readFileSync(launches, 'utf8').trim().split('\n').length}.json`);
      try {
        if (caseId === 'title') {
          const observed = process.argv.includes('--layout-stable') ? 'fixed' : value;
          assertDesktopCase(report, caseId, 'title-width', observed === 'fixed', { expected: 'fixed', observed });
        }
      } catch (error) {
        if (!report.assertionFailure) throw error;
        report.status = 'failed';
      }
      await finishDesktopCheck(report, reportPath, () => {
        if (caseId === 'cleanup') throw new Error('Isolated launcher did not exit');
      });
      return { report, reportPath };
    },
  });
  const count = fs.readFileSync(launches, 'utf8').trim().split('\n').length;
  console.log(`VERIFICATION_RESULT ${JSON.stringify({ ...result, caseId, launches: count })}`);
  if (result.outcome !== 'passed') process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
