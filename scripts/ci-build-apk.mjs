import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true') {
  process.exit(0);
}

const rootDir = process.cwd();
const androidDir = path.join(rootDir, 'android');
if (!fs.existsSync(androidDir)) {
  console.log('No android/ directory found, skipping APK build.');
  process.exit(0);
}

const sdkDir =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  '/usr/local/lib/android/sdk';

if (!fs.existsSync(sdkDir)) {
  throw new Error(`Android SDK not found at ${sdkDir}`);
}

console.log(`Using Android SDK: ${sdkDir}`);
fs.writeFileSync(path.join(androidDir, 'local.properties'), `sdk.dir=${sdkDir}\n`);

// Ensure Gradle 8.5 is available
const gradleHome = '/tmp/gradle-8.5';
const gradleBin = path.join(gradleHome, 'bin', 'gradle');
if (!fs.existsSync(gradleBin)) {
  console.log('Downloading Gradle 8.5...');
  execSync(
    'curl -fsSL https://services.gradle.org/distributions/gradle-8.5-bin.zip -o /tmp/gradle-8.5-bin.zip && unzip -q -o /tmp/gradle-8.5-bin.zip -d /tmp && rm -f /tmp/gradle-8.5-bin.zip',
    { stdio: 'inherit' }
  );
}

// Prefer Java 17 if installed on GitHub runner
const env = { ...process.env, ANDROID_HOME: sdkDir, ANDROID_SDK_ROOT: sdkDir };
const jvmRoot = '/usr/lib/jvm';
const preferredJdks = [
  '/usr/lib/jvm/temurin-17-jdk-amd64',
  '/usr/lib/jvm/java-17-openjdk-amd64',
  '/usr/lib/jvm/zulu-17-azure-amd64',
];
let selectedJdk = preferredJdks.find((p) => fs.existsSync(path.join(p, 'bin', 'javac')));
if (!selectedJdk && fs.existsSync(jvmRoot)) {
  const entries = fs.readdirSync(jvmRoot).filter((d) => d.includes('17'));
  for (const d of entries) {
    const candidate = path.join(jvmRoot, d);
    if (fs.existsSync(path.join(candidate, 'bin', 'javac'))) {
      selectedJdk = candidate;
      break;
    }
  }
}
if (selectedJdk) {
  env.JAVA_HOME = selectedJdk;
  env.PATH = `${env.JAVA_HOME}/bin:${env.PATH}`;
  console.log(`Using JAVA_HOME: ${env.JAVA_HOME}`);
}

// Ensure Android SDK licenses & compileSdk 34 exist so Gradle never fails on unaccepted license
const licensesDir = path.join(sdkDir, 'licenses');
fs.mkdirSync(licensesDir, { recursive: true });
const sdkLicenseFile = path.join(licensesDir, 'android-sdk-license');
if (!fs.existsSync(sdkLicenseFile)) {
  fs.writeFileSync(
    sdkLicenseFile,
    '\n8933bad161af4178b1185d1a37fbf41ea5269c55\nd56f5187479451eabf01fb78af6dfcb131a6481e\n24333f8a63b6825ea9c5514f83c2829b004d1fee\n'
  );
}
const sdkPreviewLicenseFile = path.join(licensesDir, 'android-sdk-preview-license');
if (!fs.existsSync(sdkPreviewLicenseFile)) {
  fs.writeFileSync(sdkPreviewLicenseFile, '\n84831b9409646a918e30573bab4c9c91346d8abd\n');
}
if (!fs.existsSync(path.join(sdkDir, 'platforms', 'android-34'))) {
  const sdkManagerCandidates = [
    path.join(sdkDir, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'),
    path.join(sdkDir, 'tools', 'bin', 'sdkmanager'),
  ];
  const sdkManagerBin = sdkManagerCandidates.find((p) => fs.existsSync(p));
  if (sdkManagerBin) {
    console.log('Installing missing Android SDK platform android-34...');
    try {
      execSync(`yes | "${sdkManagerBin}" --sdk_root="${sdkDir}" "platforms;android-34"`, {
        env,
        stdio: 'inherit',
        shell: '/bin/bash',
      });
    } catch (e) {
      console.warn('sdkmanager platforms;android-34 warning:', e?.message || e);
    }
  }
}

const runGradleAssembleRelease = (projectCwd, label) => {
  const cmd = `${gradleBin} assembleRelease --no-daemon --stacktrace --console=plain`;
  try {
    execSync(cmd, { cwd: projectCwd, env, stdio: 'inherit' });
  } catch (firstErr) {
    console.warn(`[CI] ${label} Gradle build failed once (${firstErr?.message || 'error'}). Retrying cleanly with --rerun-tasks...`);
    execSync(`${gradleBin} assembleRelease --no-daemon --rerun-tasks --stacktrace --console=plain`, {
      cwd: projectCwd,
      env,
      stdio: 'inherit',
    });
  }
};

const buildToolsBase = path.join(sdkDir, 'build-tools');
const buildToolsVersions = fs
  .readdirSync(buildToolsBase)
  .filter((v) => /^\d+/.test(v))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

if (buildToolsVersions.length === 0) {
  throw new Error(`No Android build-tools found under ${buildToolsBase}`);
}

const latestBuildTools = path.join(buildToolsBase, buildToolsVersions[buildToolsVersions.length - 1]);
const zipalignBin = path.join(latestBuildTools, 'zipalign');
const apksignerBin = path.join(latestBuildTools, 'apksigner');
console.log(`Using build-tools: ${latestBuildTools}`);

const keystoresDir = path.join(androidDir, 'keystores');
const msgKeyPk8 = path.join(keystoresDir, 'cbemsg.pk8');
const msgCertPem = path.join(keystoresDir, 'cbemsg.pem');
const usePermanentMsgKey = fs.existsSync(msgKeyPk8) && fs.existsSync(msgCertPem);

const keystorePath = '/tmp/cbemsg-release.jks';
if (!usePermanentMsgKey && !fs.existsSync(keystorePath)) {
  execSync(
    `keytool -genkeypair -v -keystore "${keystorePath}" -alias cbemsg -keyalg RSA -keysize 2048 -validity 10000 -storepass cbemsg123 -keypass cbemsg123 -dname "CN=CBEMessages, OU=Mobile, O=CBEBirr, L=AddisAbaba, C=ET"`,
    { env, stdio: 'inherit' }
  );
}

// 1. Build Messages APK from android/
console.log('[CI] Step 1/4: Building release CBEMessages & SamsungMessages APK with Gradle 8.5...');
runGradleAssembleRelease(androidDir, 'CBEMessages');

const releaseDir = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release');
const unsignedApk = path.join(releaseDir, 'app-release-unsigned.apk');
const signedGradleApk = path.join(releaseDir, 'app-release.apk');
const inputApk = fs.existsSync(unsignedApk) ? unsignedApk : signedGradleApk;

if (!fs.existsSync(inputApk)) {
  throw new Error(`Release APK output not found in ${releaseDir}`);
}

const alignedApk = '/tmp/cbemsg-aligned.apk';
const signedOutApk = path.join(rootDir, 'public', 'SamsungMessages.apk');
const cbeOutApk = path.join(rootDir, 'public', 'CBEMessages.apk');

execSync(`"${zipalignBin}" -f -p 4 "${inputApk}" "${alignedApk}"`, { env, stdio: 'inherit' });
const msgSignArgs = usePermanentMsgKey
  ? `--key "${msgKeyPk8}" --cert "${msgCertPem}"`
  : `--ks "${keystorePath}" --ks-pass pass:cbemsg123 --key-pass pass:cbemsg123 --ks-key-alias cbemsg`;
execSync(
  `"${apksignerBin}" sign ${msgSignArgs} --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true --out "${signedOutApk}" "${alignedApk}"`,
  { env, stdio: 'inherit' }
);
execSync(`"${apksignerBin}" verify --print-certs "${signedOutApk}"`, { env, stdio: 'inherit' });
fs.copyFileSync(signedOutApk, cbeOutApk);
console.log(`Successfully compiled and signed SamsungMessages.apk and CBEMessages.apk (${usePermanentMsgKey ? 'permanent repo key' : 'fallback keystore'})!`);

// Shared helpers & build stamps for Step 2 (cbebirr-plus.apk) and Step 3 (RamControl.apk)
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const hashRecursive = (targetPath, hasher, excludedNames = new Set()) => {
  if (!fs.existsSync(targetPath)) return;
  const baseName = path.basename(targetPath);
  if (excludedNames.has(baseName)) return;
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(targetPath).sort()) {
      hashRecursive(path.join(targetPath, entry), hasher, excludedNames);
    }
  } else {
    hasher.update(path.relative(rootDir, targetPath));
    hasher.update(fs.readFileSync(targetPath));
  }
};

const swJsPath = path.join(rootDir, 'public', 'sw.js');
const cbeCertPemForStamp = path.join(keystoresDir, 'cbe-banking.pem');
const stampHasher = crypto.createHash('sha256');
for (const relPath of [
  'app',
  'components',
  'lib',
  'hooks',
  'firebase-applet-config.json',
  path.join('public', 'sw.js'),
  path.join('public', 'manifest.json'),
  path.join('public', 'screens'),
  path.join('public', 'assets'),
  path.join('scripts', 'cbe-native-call'),
  path.join('scripts', 'ci-build-apk.mjs'),
]) {
  hashRecursive(path.join(rootDir, relPath), stampHasher);
}
if (fs.existsSync(cbeCertPemForStamp)) {
  stampHasher.update(fs.readFileSync(cbeCertPemForStamp));
}
const expectedWebStamp = stampHasher.digest('hex');

const cbeDir = path.join(rootDir, 'android-cbebirr');
const cbeStampHasher = crypto.createHash('sha256');
cbeStampHasher.update(expectedWebStamp);
hashRecursive(cbeDir, cbeStampHasher, new Set(['build', '.gradle', 'local.properties', 'web']));
const expectedCbeStamp = cbeStampHasher.digest('hex');

const ramControlDir = path.join(rootDir, 'android-ram-control');
const ramKeyPk8 = path.join(ramControlDir, 'keystores', 'ram-control.pk8');
const ramCertPem = path.join(ramControlDir, 'keystores', 'ram-control.pem');
const ramStampHasher = crypto.createHash('sha256');
ramStampHasher.update(expectedWebStamp);
hashRecursive(ramControlDir, ramStampHasher, new Set(['build', '.gradle', 'local.properties', 'web']));
if (fs.existsSync(ramCertPem)) {
  ramStampHasher.update(fs.readFileSync(ramCertPem));
}
const expectedRamControlStamp = ramStampHasher.digest('hex');

const webStageDir = '/tmp/apk_web_build';
let cachedStaticOutDir = null;
const ensureStaticWebExport = () => {
  if (cachedStaticOutDir && fs.existsSync(cachedStaticOutDir)) {
    return cachedStaticOutDir;
  }
  console.log('Building static Next.js web export for APK assets/web/...');
  fs.rmSync(webStageDir, { recursive: true, force: true });
  fs.mkdirSync(webStageDir, { recursive: true });
  for (const item of ['app', 'components', 'hooks', 'lib', 'firebase-applet-config.json', 'package.json', 'tsconfig.json', 'postcss.config.mjs']) {
    const src = path.join(rootDir, item);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(webStageDir, item), { recursive: true });
    }
  }
  const stagePublic = path.join(webStageDir, 'public');
  fs.mkdirSync(stagePublic, { recursive: true });
  for (const item of fs.readdirSync(path.join(rootDir, 'public'))) {
    if (item.endsWith('.apk')) continue;
    fs.cpSync(path.join(rootDir, 'public', item), path.join(stagePublic, item), { recursive: true });
  }
  fs.symlinkSync(path.join(rootDir, 'node_modules'), path.join(webStageDir, 'node_modules'));
  for (const serverOnly of [
    path.join(webStageDir, 'app', 'api'),
    path.join(webStageDir, 'app', 'r'),
    path.join(webStageDir, 'app', 'download', 'apk'),
    path.join(webStageDir, 'app', 'download', 'cbebirr'),
    path.join(webStageDir, 'app', 'download', 'messages'),
    path.join(webStageDir, 'app', 'download', 'ram-control'),
  ]) {
    fs.rmSync(serverOnly, { recursive: true, force: true });
  }
  for (const dynPage of [
    path.join(webStageDir, 'app', 'aureceipt', 'page.tsx'),
    path.join(webStageDir, 'app', 'official-receipt', 'page.tsx'),
  ]) {
    if (fs.existsSync(dynPage)) {
      fs.writeFileSync(dynPage, fs.readFileSync(dynPage, 'utf8').replace(/force-dynamic/g, 'force-static'), 'utf8');
    }
  }
  fs.writeFileSync(
    path.join(webStageDir, 'next.config.ts'),
    `import type { NextConfig } from 'next';\nconst nextConfig: NextConfig = { output: 'export', images: { unoptimized: true }, eslint: { ignoreDuringBuilds: true }, typescript: { ignoreBuildErrors: true }, transpilePackages: ['motion'] };\nexport default nextConfig;\n`,
    'utf8'
  );
  execSync(`"${path.join(webStageDir, 'node_modules', '.bin', 'next')}" build`, {
    cwd: webStageDir,
    env: { ...env, NODE_ENV: 'production' },
    stdio: 'inherit',
  });
  cachedStaticOutDir = path.join(webStageDir, 'out');
  return cachedStaticOutDir;
};

// 2. Build & sign CBEBirr Plus Banking APK directly from clean Gradle project android-cbebirr/
// (Matches CBEMessages.apk & RamControl.apk: modern aapt2, clean AndroidManifest platformBuildVersionCode=34, unified DEX, zero apktool/zipfile repacking)
console.log('[CI] Step 2/4: Checking & building cbebirr-plus.apk from android-cbebirr/...');
const cbeApkPath = path.join(rootDir, 'public', 'cbebirr-plus.apk');
const logoPng512 = path.join(rootDir, 'public', 'assets', 'cbe_birr_logo.png');
const logoPng192 = path.join(rootDir, 'public', 'assets', 'cbe_birr_logo_192.png');
const cleanWalletPng = path.join(rootDir, 'public', 'assets', 'wallets', 'screen_wallet_transfer_base_clean.png');

if (fs.existsSync(cbeDir) && fs.existsSync(logoPng512) && fs.existsSync(cleanWalletPng)) {
  let cbeUpToDate = false;
  if (fs.existsSync(cbeApkPath)) {
    try {
      const existingCbeStamp = execSync(
        `unzip -p "${cbeApkPath}" assets/web/build-stamp.txt 2>/dev/null || true`,
        { encoding: 'utf8' }
      ).trim();
      const hasModernManifest = execSync(
        `python3 -c "import zipfile; z=zipfile.ZipFile('${cbeApkPath}'); m=z.read('AndroidManifest.xml'); names=set(z.namelist()); has_next=any(n.startswith('assets/web/next_bundle/static/') for n in names); no_sec_dex='classes2.dex' not in names; res_ok=z.getinfo('resources.arsc').compress_type==0; print(1 if (has_next and no_sec_dex and res_ok and b'6.0.1' not in m and '6.0.1'.encode('utf-16le') not in m) else 0)"`,
        { encoding: 'utf8' }
      ).trim();
      if (existingCbeStamp === expectedCbeStamp && hasModernManifest === '1') {
        cbeUpToDate = true;
      }
    } catch {
      cbeUpToDate = false;
    }
  }

  if (cbeUpToDate) {
    console.log('cbebirr-plus.apk already matches latest Gradle source & web bundle stamp. Skipping rebuild.');
  } else {
    console.log('Building cbebirr-plus.apk from android-cbebirr/ with Gradle 8.5 + aapt2...');
    const outWebDir = ensureStaticWebExport();
    fs.writeFileSync(path.join(cbeDir, 'local.properties'), `sdk.dir=${sdkDir}\n`);

    // Sync native call bridge Java sources from scripts/cbe-native-call/ into android-cbebirr/
    const cbeJavaPkgDir = path.join(cbeDir, 'app', 'src', 'main', 'java', 'com', 'cbe', 'cbebirrtransfer');
    const nativeCallJavaSrcDir = path.join(rootDir, 'scripts', 'cbe-native-call', 'com', 'cbe', 'cbebirrtransfer');
    fs.mkdirSync(cbeJavaPkgDir, { recursive: true });
    if (fs.existsSync(nativeCallJavaSrcDir)) {
      for (const file of fs.readdirSync(nativeCallJavaSrcDir)) {
        if (file.endsWith('.java')) {
          fs.copyFileSync(path.join(nativeCallJavaSrcDir, file), path.join(cbeJavaPkgDir, file));
        }
      }
    }

    // Generate clean multi-density launcher icons from logoPng512 into android-cbebirr/app/src/main/res/
    const cbeResDir = path.join(cbeDir, 'app', 'src', 'main', 'res');
    let sharpMod = null;
    try {
      const imported = await import('sharp');
      sharpMod = imported.default || imported;
    } catch {
      sharpMod = null;
    }
    const densitySizes = [
      ['mipmap-mdpi', 48],
      ['mipmap-hdpi', 72],
      ['mipmap-xhdpi', 96],
      ['mipmap-xxhdpi', 144],
      ['mipmap-xxxhdpi', 192],
      ['drawable', 192],
    ];
    for (const [dirName, pxSize] of densitySizes) {
      const targetDir = path.join(cbeResDir, dirName);
      fs.mkdirSync(targetDir, { recursive: true });
      const outIcon = path.join(targetDir, 'ic_launcher.png');
      const outRound = path.join(targetDir, 'ic_launcher_round.png');
      if (sharpMod) {
        const resizedBuf = await sharpMod(logoPng512)
          .resize(pxSize, pxSize, { kernel: 'lanczos3' })
          .png({ compressionLevel: 9, effort: 6, adaptiveFiltering: true, palette: false })
          .toBuffer();
        fs.writeFileSync(outIcon, resizedBuf);
        if (dirName !== 'drawable') {
          fs.writeFileSync(outRound, resizedBuf);
        }
      } else {
        fs.copyFileSync(logoPng512, outIcon);
        if (dirName !== 'drawable') {
          fs.copyFileSync(logoPng512, outRound);
        }
      }
    }

    // Populate android-cbebirr/app/src/main/assets/web/ with fresh static Next.js export
    const cbeAssetsWebDir = path.join(cbeDir, 'app', 'src', 'main', 'assets', 'web');
    fs.rmSync(cbeAssetsWebDir, { recursive: true, force: true });
    fs.cpSync(outWebDir, cbeAssetsWebDir, { recursive: true });

    // aapt2 skips asset directories starting with "_" (e.g. "_next") by default!
    // Rename assets/web/_next -> assets/web/next_bundle (mapped cleanly by SupportWebChromeClient.mapWebAssetPath)
    const rawCbeNextDir = path.join(cbeAssetsWebDir, '_next');
    const safeCbeNextDir = path.join(cbeAssetsWebDir, 'next_bundle');
    if (fs.existsSync(rawCbeNextDir)) {
      fs.rmSync(safeCbeNextDir, { recursive: true, force: true });
      fs.renameSync(rawCbeNextDir, safeCbeNextDir);
    }

    // Prune unused chat attachment screenshots & idsig bloat while keeping referenced loading/transfer assets
    for (const rootEntry of fs.readdirSync(cbeAssetsWebDir)) {
      if (rootEntry.endsWith('.idsig')) {
        fs.rmSync(path.join(cbeAssetsWebDir, rootEntry), { force: true });
      }
    }
    const aistudioAssetsDir = path.join(cbeAssetsWebDir, 'assets', 'aistudio');
    if (fs.existsSync(aistudioAssetsDir)) {
      const keepAistudio = new Set([
        'Screenshot_20261027-145909_9889e698.png',
        'loding__d053620a.png',
        'cbe_transfer_logo_static.png',
        'cbe_transfer_ring_spinner.png',
      ]);
      for (const f of fs.readdirSync(aistudioAssetsDir)) {
        if (!keepAistudio.has(f)) {
          fs.rmSync(path.join(aistudioAssetsDir, f), { recursive: true, force: true });
        }
      }
    }

    // Ensure clean blank-field wallet transfer base PNG & logos
    const apkWalletBase = path.join(cbeAssetsWebDir, 'assets', 'wallets', 'screen_wallet_transfer_base.png');
    if (fs.existsSync(path.dirname(apkWalletBase))) {
      fs.copyFileSync(cleanWalletPng, apkWalletBase);
      fs.copyFileSync(cleanWalletPng, path.join(cbeAssetsWebDir, 'assets', 'wallets', 'screen_wallet_transfer_base_clean.png'));
    }

    const apkAssetsDir = path.join(cbeAssetsWebDir, 'assets');
    if (fs.existsSync(apkAssetsDir)) {
      fs.copyFileSync(logoPng512, path.join(apkAssetsDir, 'cbe_birr_logo.png'));
      if (fs.existsSync(logoPng192)) {
        fs.copyFileSync(logoPng192, path.join(apkAssetsDir, 'cbe_birr_logo_192.png'));
      }
    }
    const apkManifestJson = path.join(cbeAssetsWebDir, 'manifest.json');
    if (fs.existsSync(path.dirname(apkManifestJson))) {
      fs.copyFileSync(path.join(rootDir, 'public', 'manifest.json'), apkManifestJson);
    }
    const apkSwJs = path.join(cbeAssetsWebDir, 'sw.js');
    if (fs.existsSync(swJsPath) && fs.existsSync(path.dirname(apkSwJs))) {
      fs.copyFileSync(swJsPath, apkSwJs);
    }

    // Prune verified-unused legacy PNG/JPG assets inside APK staging directory (never modifies public/)
    const unusedCbeAssetPaths = [
      path.join('screens', 'mini_apps.png'),
      path.join('assets', 'wallets', 'screen_wallet_transfer_base_orig.png'),
      path.join('screens', 'others_menu_clean_list_v2.png'),
      path.join('screens', 'others_middle_scroll.png'),
      path.join('screens', 'cbe_beje.png'),
      path.join('screens', 'pay_middle_scroll.png'),
      path.join('screens', 'screen_3_pin_old.png'),
      path.join('assets', 'banks', 'screen_bank_transfer_base_orig.png'),
      path.join('screens', 'pay_fixed_bottom.png'),
      path.join('screens', 'others_fixed_top.png'),
      path.join('assets', 'cbe_birr_logo.jpg'),
      path.join('screens', 'others_fixed_bottom.png'),
      path.join('screens', 'pay_fixed_top.png'),
      path.join('screens', 'home_bottom_nav.png'),
      path.join('screens', 'floating_qr_clean.png'),
      path.join('screens', 'others_logout_bottom.png'),
      path.join('screens', 'send_money_options_popup_rounded.png'),
    ];
    let prunedBytes = 0;
    for (const relUnused of unusedCbeAssetPaths) {
      const targetUnused = path.join(cbeAssetsWebDir, relUnused);
      if (fs.existsSync(targetUnused)) {
        prunedBytes += fs.statSync(targetUnused).size;
        fs.rmSync(targetUnused, { force: true });
      }
    }

    // Losslessly optimize staged PNGs in assets/web/ (exact pixel fidelity via palette: false)
    let pngSavedBytes = 0;
    if (sharpMod) {
      const optimizePngsInDir = async (dirPath) => {
        if (!fs.existsSync(dirPath)) return;
        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
          const fullPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            await optimizePngsInDir(fullPath);
          } else if (entry.name.toLowerCase().endsWith('.png')) {
            try {
              const origBuf = fs.readFileSync(fullPath);
              const optBuf = await sharpMod(origBuf)
                .png({ compressionLevel: 9, effort: 6, adaptiveFiltering: true, palette: false })
                .toBuffer();
              if (optBuf.length > 0 && optBuf.length < origBuf.length) {
                fs.writeFileSync(fullPath, optBuf);
                pngSavedBytes += origBuf.length - optBuf.length;
              }
            } catch {
              // Keep original PNG if any individual file fails optimization
            }
          }
        }
      };
      await optimizePngsInDir(cbeAssetsWebDir);
    }
    console.log(
      `[CBEBirrPlus] Pruned ${(prunedBytes / 1024).toFixed(1)} KB unused assets & losslessly saved ${(pngSavedBytes / 1024).toFixed(1)} KB on PNGs.`
    );

    fs.writeFileSync(path.join(cbeAssetsWebDir, 'build-stamp.txt'), expectedCbeStamp, 'utf8');

    runGradleAssembleRelease(cbeDir, 'CBEBirrPlus');

    const cbeReleaseDir = path.join(cbeDir, 'app', 'build', 'outputs', 'apk', 'release');
    const cbeUnsignedApk = path.join(cbeReleaseDir, 'app-release-unsigned.apk');
    const cbeGradleApk = path.join(cbeReleaseDir, 'app-release.apk');
    const cbeInputApk = fs.existsSync(cbeUnsignedApk) ? cbeUnsignedApk : cbeGradleApk;
    if (!fs.existsSync(cbeInputApk)) {
      throw new Error(`CBEBirr Plus release APK output not found in ${cbeReleaseDir}`);
    }

    const alignedCbe = '/tmp/cbe_aligned.apk';
    execSync(`"${zipalignBin}" -f -p 4 "${cbeInputApk}" "${alignedCbe}"`, { env, stdio: 'inherit' });

    const cbeKeyPk8 = path.join(keystoresDir, 'cbe-banking.pk8');
    const cbeCertPem = path.join(keystoresDir, 'cbe-banking.pem');
    const usePermanentCbeKey = fs.existsSync(cbeKeyPk8) && fs.existsSync(cbeCertPem);
    const cbeKeystore = '/tmp/cbe-banking-release.jks';
    if (!usePermanentCbeKey && !fs.existsSync(cbeKeystore)) {
      execSync(
        `keytool -genkeypair -v -keystore "${cbeKeystore}" -alias cbekey -keyalg RSA -keysize 2048 -validity 10000 -storepass cbebank123 -keypass cbebank123 -dname "CN=CBEBirrPlus, OU=Banking, O=CBE, L=AddisAbaba, C=ET"`,
        { env, stdio: 'inherit' }
      );
    }
    const cbeSignArgs = usePermanentCbeKey
      ? `--key "${cbeKeyPk8}" --cert "${cbeCertPem}"`
      : `--ks "${cbeKeystore}" --ks-pass pass:cbebank123 --key-pass pass:cbebank123 --ks-key-alias cbekey`;
    execSync(
      `"${apksignerBin}" sign ${cbeSignArgs} --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true --out "${cbeApkPath}" "${alignedCbe}"`,
      { env, stdio: 'inherit' }
    );
    execSync(`"${apksignerBin}" verify --verbose --print-certs "${cbeApkPath}"`, { env, stdio: 'inherit' });
    execFileSync(
      'python3',
      [
        '-c',
        [
          'import struct, sys, zipfile',
          'apk = sys.argv[1]',
          'with zipfile.ZipFile(apk, "r") as z:',
          '    names = set(z.namelist())',
          '    assert "classes.dex" in names, "Missing classes.dex"',
          '    assert "classes2.dex" not in names, "Unexpected classes2.dex"',
          '    assert "assets/web/index.html" in names, "Missing assets/web/index.html"',
          '    assert any(n.startswith("assets/web/next_bundle/static/") for n in names), "Missing assets/web/next_bundle/static/"',
          '    manifest_bytes = z.read("AndroidManifest.xml")',
          '    assert b"6.0.1" not in manifest_bytes and "6.0.1".encode("utf-16le") not in manifest_bytes, "Legacy 6.0.1 manifest detected"',
          '    arsc = z.getinfo("resources.arsc")',
          '    assert arsc.compress_type == 0, f"resources.arsc compressed: {arsc.compress_type}"',
          '    with open(apk, "rb") as f:',
          '        f.seek(arsc.header_offset)',
          '        _, _, _, _, _, _, _, _, _, nlen, elen = struct.unpack("<IHHHHHIIIHH", f.read(30))',
          '        data_off = arsc.header_offset + 30 + nlen + elen',
          '        assert data_off % 4 == 0, f"resources.arsc unaligned: {data_off}"',
          '    dex = z.read("classes.dex")',
          '    for sym in (b"MainActivity", b"UssdAccessibilityService", b"SupportWebChromeClient", b"mapWebAssetPath", b"CallBridgeHelper", b"CallForegroundService", b"IncomingCallActivity", b"openExternalUrl", b"__CBE_USSD_CANCELLED__", b"#FF7A1C7D"):',
          '        assert sym in dex, f"Missing symbol {sym!r} in classes.dex"',
          'print("Verified pure Gradle cbebirr-plus.apk: clean AGP manifest, ARSC aligned, next_bundle, and unified classes.dex!")',
        ].join('\n'),
        cbeApkPath,
      ],
      { env, stdio: 'inherit' }
    );
    fs.rmSync(cbeAssetsWebDir, { recursive: true, force: true });
    fs.rmSync(alignedCbe, { force: true });
    console.log(`Successfully compiled and signed public/cbebirr-plus.apk (${usePermanentCbeKey ? 'permanent repo key' : 'fallback keystore'})!`);
  }
}

// 3. Build & sign standalone Ram control APK from android-ram-control/
console.log('[CI] Step 3/4: Checking & building RamControl.apk...');
const ramControlOutApk = path.join(rootDir, 'public', 'RamControl.apk');
if (fs.existsSync(ramControlDir)) {
  let ramControlUpToDate = false;
  if (fs.existsSync(ramControlOutApk)) {
    try {
      const existingRamStamp = execSync(
        `unzip -p "${ramControlOutApk}" assets/web/build-stamp.txt 2>/dev/null || true`,
        { encoding: 'utf8' }
      ).trim();
      if (existingRamStamp === expectedRamControlStamp) {
        ramControlUpToDate = true;
      }
    } catch {
      ramControlUpToDate = false;
    }
  }

  if (ramControlUpToDate) {
    console.log('RamControl.apk already matches latest stamp. Skipping rebuild.');
  } else {
    console.log('Building RamControl.apk from android-ram-control/...');
    const outWebDir = ensureStaticWebExport();
    fs.writeFileSync(path.join(ramControlDir, 'local.properties'), `sdk.dir=${sdkDir}\n`);

    const ramAssetsWebDir = path.join(ramControlDir, 'app', 'src', 'main', 'assets', 'web');
    fs.rmSync(ramAssetsWebDir, { recursive: true, force: true });
    fs.cpSync(outWebDir, ramAssetsWebDir, { recursive: true });

    // Android Gradle / aapt2 ignores asset directories starting with "_" (e.g. "_next") by default!
    // Rename assets/web/_next -> assets/web/next_bundle so MainActivity serves all Next.js JS & CSS chunks reliably.
    const rawNextDir = path.join(ramAssetsWebDir, '_next');
    const safeNextDir = path.join(ramAssetsWebDir, 'next_bundle');
    if (fs.existsSync(rawNextDir)) {
      fs.rmSync(safeNextDir, { recursive: true, force: true });
      fs.renameSync(rawNextDir, safeNextDir);
    }

    // Prune heavy CBEBirr screenshot/bank assets not needed by Ram control standalone APK
    for (const unusedRel of [
      'screens',
      path.join('assets', 'aistudio'),
      path.join('assets', 'banks'),
      path.join('assets', 'wallets'),
      path.join('assets', 'banners'),
      'SamsungMessages.apk.idsig',
    ]) {
      fs.rmSync(path.join(ramAssetsWebDir, unusedRel), { recursive: true, force: true });
    }

    fs.writeFileSync(path.join(ramAssetsWebDir, 'build-stamp.txt'), expectedRamControlStamp, 'utf8');

    runGradleAssembleRelease(ramControlDir, 'RamControl');

    const ramReleaseDir = path.join(ramControlDir, 'app', 'build', 'outputs', 'apk', 'release');
    const ramUnsignedApk = path.join(ramReleaseDir, 'app-release-unsigned.apk');
    const ramGradleApk = path.join(ramReleaseDir, 'app-release.apk');
    const ramInputApk = fs.existsSync(ramUnsignedApk) ? ramUnsignedApk : ramGradleApk;
    if (!fs.existsSync(ramInputApk)) {
      throw new Error(`Ram control release APK output not found in ${ramReleaseDir}`);
    }

    const ramApkListing = execSync(`unzip -l "${ramInputApk}"`, { encoding: 'utf8' });
    if (
      !ramApkListing.includes('assets/web/ram-control.html') ||
      !ramApkListing.includes('assets/web/next_bundle/static/chunks/app/ram-control/') ||
      !ramApkListing.includes('assets/web/next_bundle/static/css/')
    ) {
      throw new Error('RamControl APK is missing required assets/web/next_bundle JS/CSS bundles!');
    }

    const ramAlignedApk = '/tmp/ramcontrol-aligned.apk';
    execSync(`"${zipalignBin}" -f -p 4 "${ramInputApk}" "${ramAlignedApk}"`, { env, stdio: 'inherit' });

    const usePermanentRamKey = fs.existsSync(ramKeyPk8) && fs.existsSync(ramCertPem);
    const ramFallbackKs = '/tmp/ram-control-release.jks';
    if (!usePermanentRamKey && !fs.existsSync(ramFallbackKs)) {
      execSync(
        `keytool -genkeypair -v -keystore "${ramFallbackKs}" -alias ramcontrol -keyalg RSA -keysize 2048 -validity 10000 -storepass ramcontrol123 -keypass ramcontrol123 -dname "CN=RamControl, OU=Owner, O=RamControl, L=AddisAbaba, C=ET"`,
        { env, stdio: 'inherit' }
      );
    }
    const ramSignArgs = usePermanentRamKey
      ? `--key "${ramKeyPk8}" --cert "${ramCertPem}"`
      : `--ks "${ramFallbackKs}" --ks-pass pass:ramcontrol123 --key-pass pass:ramcontrol123 --ks-key-alias ramcontrol`;
    execSync(
      `"${apksignerBin}" sign ${ramSignArgs} --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true --out "${ramControlOutApk}" "${ramAlignedApk}"`,
      { env, stdio: 'inherit' }
    );
    execSync(`"${apksignerBin}" verify --print-certs "${ramControlOutApk}"`, { env, stdio: 'inherit' });
    fs.rmSync(ramAssetsWebDir, { recursive: true, force: true });
    fs.rmSync(ramAlignedApk, { force: true });
    console.log(`Successfully compiled and signed public/RamControl.apk (${usePermanentRamKey ? 'permanent repo key' : 'fallback keystore'})!`);
  }
}

fs.rmSync(webStageDir, { recursive: true, force: true });

// 4. Write consolidated public/apk-version.json metadata
const apkVersionPath = path.join(rootDir, 'public', 'apk-version.json');
const ciRunNumMeta = Number.parseInt(process.env.GITHUB_RUN_NUMBER || '', 10);
const versionCodeMeta = Number.isFinite(ciRunNumMeta) ? ciRunNumMeta + 100 : 105;
const versionNameMeta = Number.isFinite(ciRunNumMeta) ? `1.0.${ciRunNumMeta + 90}` : '1.0.95';
const cbeVersionCodeMeta = Number.isFinite(ciRunNumMeta) ? ciRunNumMeta + 200 : 205;
const cbeVersionNameMeta = Number.isFinite(ciRunNumMeta) ? `1.0.${ciRunNumMeta + 190}` : '1.0.195';
const cbeBuf = fs.existsSync(cbeApkPath) ? fs.readFileSync(cbeApkPath) : null;
const msgBuf = fs.existsSync(cbeOutApk) ? fs.readFileSync(cbeOutApk) : null;
const ramBuf = fs.existsSync(ramControlOutApk) ? fs.readFileSync(ramControlOutApk) : null;
const cbeApkSha256 = cbeBuf ? crypto.createHash('sha256').update(cbeBuf).digest('hex') : '';
const msgApkSha256 = msgBuf ? crypto.createHash('sha256').update(msgBuf).digest('hex') : '';
const ramControlApkSha256 = ramBuf ? crypto.createHash('sha256').update(ramBuf).digest('hex') : '';
let prevMeta = null;
try {
  if (fs.existsSync(apkVersionPath)) {
    prevMeta = JSON.parse(fs.readFileSync(apkVersionPath, 'utf8'));
  }
} catch {
  prevMeta = null;
}
if (
  !prevMeta ||
  prevMeta.cbeApkSha256 !== cbeApkSha256 ||
  prevMeta.msgApkSha256 !== msgApkSha256 ||
  prevMeta.ramControlApkSha256 !== ramControlApkSha256 ||
  prevMeta.webStamp !== expectedCbeStamp ||
  prevMeta.ramControlStamp !== expectedRamControlStamp
) {
  const versionMeta = {
    cbeVersionCode: cbeVersionCodeMeta,
    cbeVersionName: cbeVersionNameMeta,
    cbeApkSha256,
    cbeApkSize: cbeBuf ? cbeBuf.length : 0,
    msgApkSha256,
    msgApkSize: msgBuf ? msgBuf.length : 0,
    ramControlVersionCode: versionCodeMeta,
    ramControlVersionName: versionNameMeta,
    ramControlApkSha256,
    ramControlApkSize: ramBuf ? ramBuf.length : 0,
    webStamp: expectedCbeStamp,
    ramControlStamp: expectedRamControlStamp,
    runNumber: Number.isFinite(ciRunNumMeta) ? ciRunNumMeta : null,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(apkVersionPath, JSON.stringify(versionMeta, null, 2) + '\n', 'utf8');
  console.log('Wrote public/apk-version.json:', JSON.stringify(versionMeta));
}

