'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');

(async () => {
  const { packager } = await import('@electron/packager');
  const root = path.resolve(__dirname, '..');
  const destination = path.resolve(root, '..', 'outputs');
  // Package an explicit allowlist. Server data, bridge SDKs and tools never enter
  // the desktop archive even if future workspace directories are added.
  const buildRoot = path.resolve(root, '..', 'environment', 'build');
  await fs.mkdir(buildRoot, { recursive: true });
  const stage = await fs.mkdtemp(path.join(buildRoot, 'desktop-stage-'));
  await fs.cp(path.join(root, 'client'), path.join(stage, 'client'), { recursive: true });
  await fs.mkdir(path.join(stage, 'desktop'));
  await fs.copyFile(path.join(root, 'desktop', 'main.cjs'), path.join(stage, 'desktop', 'main.cjs'));
  const sourcePackage = require('../package.json');
  await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({
    name: sourcePackage.name, version: sourcePackage.version,
    description: sourcePackage.description, main: sourcePackage.main,
    author: sourcePackage.author, license: sourcePackage.license
  }, null, 2));
  const results = await packager({
    dir: stage, out: destination, name: 'TeamRelay', executableName: 'TeamRelay',
    platform: 'win32', arch: 'x64', overwrite: true, asar: true,
    electronVersion: require('electron/package.json').version,
    download: {
      cacheRoot: process.env.electron_config_cache,
      checksums: require('electron/checksums.json')
    },
    appCopyright: 'Copyright © 2026 walcracia',
    appVersion: sourcePackage.version,
    win32metadata: { CompanyName: 'Team Relay', FileDescription: '同频 · 小团队私有 IM', ProductName: '同频 Team Relay' },
    prune: true
  });
  await fs.writeFile(path.join(destination, 'WINDOWS-README.txt'), '同频 Team Relay Windows x64 便携客户端\r\n\r\n打开 TeamRelay-win32-x64\\TeamRelay.exe。\r\n填写服务器根地址、团队用户名和密码；账号由管理员创建。\r\n客户端只连接服务器，不需要安装 Python。\r\n每个文件严格小于 100 MB。音视频无法预览时可下载到本机播放。\r\n此包未进行代码签名。\r\n', 'utf8');
  results.forEach((output) => console.log(output));
})().catch((error) => { console.error(error); process.exitCode = 1; });
