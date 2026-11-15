// Optional certificate setup for disposable GitHub runners. Never read local credential stores.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const run = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const env = (name, value) => {
  if (/[\r\n]/.test(value)) throw new Error('Invalid signing environment value');
  appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
};
if (process.env.GITHUB_ACTIONS !== 'true')
  throw new Error('Signing setup runs only on disposable GitHub Actions runners.');
const root = join(process.env.RUNNER_TEMP, 'agentcue-signing');
if (process.argv[2] === 'cleanup') {
  if (process.platform === 'darwin') {
    try {
      run('security', ['delete-keychain', join(root, 'build.keychain-db')]);
    } catch {
      /* No keychain exists on unsigned builds. */
    }
  }
  if (process.platform === 'win32' && process.env.AGENTCUE_WINDOWS_THUMBPRINT) {
    run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Remove-Item ('Cert:\\CurrentUser\\My\\' + $env:AGENTCUE_WINDOWS_THUMBPRINT) -ErrorAction SilentlyContinue",
    ]);
  }
  rmSync(root, { recursive: true, force: true });
  rmSync('apps/tauri/.signing-bundle.conf.json', { force: true });
} else {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    if (process.platform === 'darwin') {
      if (!process.env.APPLE_CERTIFICATE) {
        env('APPLE_SIGNING_IDENTITY', '-');
        process.exit(0);
      }
      for (const key of [
        'APPLE_CERTIFICATE_PASSWORD',
        'APPLE_ID',
        'APPLE_PASSWORD',
        'APPLE_TEAM_ID',
      ])
        if (!process.env[key]) throw new Error(`Signing is configured but ${key} is missing.`);
      const cert = join(root, 'certificate.p12'),
        keychain = join(root, 'build.keychain-db'),
        password = randomUUID();
      writeFileSync(cert, Buffer.from(process.env.APPLE_CERTIFICATE, 'base64'), { mode: 0o600 });
      run('security', ['create-keychain', '-p', password, keychain]);
      run('security', ['unlock-keychain', '-p', password, keychain]);
      run('security', ['set-keychain-settings', '-t', '3600', '-u', keychain]);
      run('security', [
        'import',
        cert,
        '-k',
        keychain,
        '-P',
        process.env.APPLE_CERTIFICATE_PASSWORD,
        '-T',
        '/usr/bin/codesign',
      ]);
      run('security', [
        'set-key-partition-list',
        '-S',
        'apple-tool:,apple:,codesign:',
        '-s',
        '-k',
        password,
        keychain,
      ]);
      const previous =
        run('security', ['list-keychains', '-d', 'user'])
          .match(/"([^"]+)"/g)
          ?.map((s) => s.slice(1, -1)) ?? [];
      run('security', ['list-keychains', '-d', 'user', '-s', ...previous, keychain]);
      const identities = run('security', ['find-identity', '-v', '-p', 'codesigning', keychain]);
      const identity =
        process.env.APPLE_SIGNING_IDENTITY ||
        identities.match(/"(Developer ID Application:[^"]+)"/)?.[1];
      if (!identity) throw new Error('A Developer ID Application identity is required.');
      env('APPLE_SIGNING_IDENTITY', identity);
      env('APPLE_ID', process.env.APPLE_ID);
      env('APPLE_PASSWORD', process.env.APPLE_PASSWORD);
      env('APPLE_TEAM_ID', process.env.APPLE_TEAM_ID);
      rmSync(cert);
    }
    if (process.platform === 'win32' && process.env.WINDOWS_CERTIFICATE) {
      if (!process.env.WINDOWS_CERTIFICATE_PASSWORD)
        throw new Error('Windows certificate password is missing.');
      const thumbprint = run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; $path=Join-Path $env:RUNNER_TEMP 'agentcue-signing/certificate.pfx'; [IO.File]::WriteAllBytes($path,[Convert]::FromBase64String($env:WINDOWS_CERTIFICATE)); $password=ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force; $cert=Import-PfxCertificate -FilePath $path -CertStoreLocation Cert:\\CurrentUser\\My -Password $password; [Console]::Write($cert.Thumbprint); Remove-Item $path",
      ]).trim();
      if (!/^[A-Fa-f0-9]{40}$/.test(thumbprint))
        throw new Error('Certificate import did not return a valid thumbprint.');
      env('AGENTCUE_WINDOWS_THUMBPRINT', thumbprint);
      const config = JSON.parse(readFileSync('apps/tauri/bundle.conf.json', 'utf8'));
      config.bundle.windows = {
        certificateThumbprint: thumbprint,
        digestAlgorithm: 'sha256',
        timestampUrl: process.env.WINDOWS_TIMESTAMP_URL || 'http://timestamp.comodoca.com',
      };
      const file = join(process.cwd(), 'apps/tauri/.signing-bundle.conf.json');
      writeFileSync(file, JSON.stringify(config));
      env('AGENTCUE_SIGNING_CONFIG', file);
    }
  } catch (error) {
    console.error(
      'Certificate preparation failed. Check the signing secrets and certificate validity.',
    );
    process.exitCode = 1;
  }
}
