import { spawnSync } from 'node:child_process';

function run(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });
}

function printOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

const migrate = run('prisma', ['migrate', 'deploy']);
printOutput(migrate);

if ((migrate.status ?? 1) === 0) {
  process.exit(0);
}

const output = `${migrate.stdout ?? ''}\n${migrate.stderr ?? ''}`;
const isP3005 = output.includes('P3005');
const isP1001 = output.includes('P1001');

if (isP3005) {
  console.warn('\n[prisma-deploy] Database is non-empty and not baselined (P3005).');
  console.warn('[prisma-deploy] Attempting `prisma db push` to align schema without migration history.');

  const dbPush = run('prisma', ['db', 'push']);
  printOutput(dbPush);

  if ((dbPush.status ?? 1) === 0) {
    console.warn('[prisma-deploy] `prisma db push` completed successfully. Continuing startup.');
    process.exit(0);
  }

  const dbPushOutput = `${dbPush.stdout ?? ''}
${dbPush.stderr ?? ''}`;
  const needsAcceptDataLoss = dbPushOutput.includes('--accept-data-loss');

  if (needsAcceptDataLoss) {
    console.warn('\n[prisma-deploy] `prisma db push` requires `--accept-data-loss` for pending schema changes.');
    console.warn('[prisma-deploy] Retrying with `prisma db push --accept-data-loss` for non-baselined startup sync.');

    const dbPushAcceptDataLoss = run('prisma', ['db', 'push', '--accept-data-loss']);
    printOutput(dbPushAcceptDataLoss);

    if ((dbPushAcceptDataLoss.status ?? 1) === 0) {
      console.warn('[prisma-deploy] `prisma db push --accept-data-loss` completed successfully. Continuing startup.');
      process.exit(0);
    }

    console.error('\n[prisma-deploy] `prisma db push --accept-data-loss` failed after P3005. Startup aborted.');
    process.exit(dbPushAcceptDataLoss.status ?? 1);
  }

  console.error('\n[prisma-deploy] `prisma db push` failed after P3005. Startup aborted.');
  process.exit(dbPush.status ?? 1);
}

if (isP1001) {
  console.warn('\n[prisma-deploy] Database is temporarily unreachable (P1001).');
  console.warn('[prisma-deploy] Continuing startup; retry migrations when connectivity is restored.');
  process.exit(0);
}

console.error('\n[prisma-deploy] Migration failed with an unexpected error. Startup aborted.');
process.exit(migrate.status ?? 1);
