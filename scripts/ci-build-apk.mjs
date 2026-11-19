import { execSync } from 'node:child_process';
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
if (fs.existsSync('/usr/lib/jvm/temurin-17-jdk-amd64')) {
  env.JAVA_HOME = '/usr/lib/jvm/temurin-17-jdk-amd64';
  env.PATH = `${env.JAVA_HOME}/bin:${env.PATH}`;
}

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
execSync(`${gradleBin} assembleRelease --no-daemon`, {
  cwd: androidDir,
  env,
  stdio: 'inherit',
});

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

// 2. Cleanly update CBEBirr Plus Banking APK (Web bundle + UssdAccessibilityService opaque overlay & no 12s timeout + icon + wallet PNG)
console.log('[CI] Step 2/4: Checking & updating cbebirr-plus.apk...');
const cbeApkPath = path.join(rootDir, 'public', 'cbebirr-plus.apk');
const logoPng512 = path.join(rootDir, 'public', 'assets', 'cbe_birr_logo.png');
const logoPng192 = path.join(rootDir, 'public', 'assets', 'cbe_birr_logo_192.png');
const cleanWalletPng = path.join(rootDir, 'public', 'assets', 'wallets', 'screen_wallet_transfer_base_clean.png');

if (fs.existsSync(cbeApkPath) && fs.existsSync(logoPng512) && fs.existsSync(cleanWalletPng)) {
  const expectedWalletHash = sha256(cleanWalletPng);
  const expectedSwHash = fs.existsSync(swJsPath) ? sha256(swJsPath) : '';
  const expectedIconHash = sha256(logoPng512);
  let alreadyPatched = false;
  try {
    const hasIcon = execSync(
      `unzip -l "${cbeApkPath}" | grep -c "res/mipmap-xxxhdpi/ic_launcher.png"`,
      { encoding: 'utf8' }
    ).trim();
    const existingIconHash = execSync(
      `unzip -p "${cbeApkPath}" res/drawable/ic_launcher.png 2>/dev/null | sha256sum | awk '{print $1}'`,
      { encoding: 'utf8' }
    ).trim();
    const existingWalletHash = execSync(
      `unzip -p "${cbeApkPath}" assets/web/assets/wallets/screen_wallet_transfer_base.png | sha256sum | awk '{print $1}'`,
      { encoding: 'utf8' }
    ).trim();
    const existingSwHash = execSync(
      `unzip -p "${cbeApkPath}" assets/web/sw.js | sha256sum | awk '{print $1}'`,
      { encoding: 'utf8' }
    ).trim();
    const existingWebStamp = execSync(
      `unzip -p "${cbeApkPath}" assets/web/build-stamp.txt 2>/dev/null || true`,
      { encoding: 'utf8' }
    ).trim();
    const hasOpaqueOverlayAndNoTimeout = execSync(
      `unzip -p "${cbeApkPath}" classes.dex | python3 -c "import sys; d=sys.stdin.buffer.read(); print(1 if (b'#FF7A1C7D' in d and b'#99000000' not in d and b'__CBE_USSD_CANCELLED__' in d and b'UssdAccessibilityService$4' in d and b'exitApp' in d and b'lockTextZoom' in d and b'setTextZoom' in d and b'SupportWebChromeClient' in d and b'setMediaPlaybackRequiresUserGesture' in d) else 0)"`,
      { encoding: 'utf8' }
    ).trim();
    const hasAudioPerms = execSync(
      `unzip -p "${cbeApkPath}" AndroidManifest.xml | python3 -c "import sys; m=sys.stdin.buffer.read(); print(1 if (b'RECORD_AUDIO' in m or 'RECORD_AUDIO'.encode('utf-16le') in m) else 0)"`,
      { encoding: 'utf8' }
    ).trim();
    const hasMsgQueries = execSync(
      `unzip -p "${cbeApkPath}" AndroidManifest.xml | python3 -c "import sys; m=sys.stdin.buffer.read(); print(1 if (b'com.cbebirr.messages.cbe' in m or 'com.cbebirr.messages.cbe'.encode('utf-16le') in m) else 0)"`,
      { encoding: 'utf8' }
    ).trim();
    const hasAdjustNothing = execSync(
      `unzip -p "${cbeApkPath}" AndroidManifest.xml | python3 -c "import sys,struct; m=sys.stdin.buffer.read(); pos=8; ss=[]; ok=0\nwhile pos<len(m):\n ct,hs,cs=struct.unpack_from('<HHI',m,pos)\n if ct==1:\n  sc,_,_,so,_=struct.unpack_from('<IIIII',m,pos+8); u8=bool(struct.unpack_from('<I',m,pos+16)[0]&256); offs=struct.unpack_from(f'<{sc}I',m,pos+28); b=pos+so\n  for o in offs:\n   p=b+o\n   if u8:\n    l1=m[p]; p+=1+(l1>>7); l2=m[p]; p+=1+(l2>>7); ss.append(m[p:p+((l2&127)|(m[p-1]&127<<7) if False else l2)].decode('utf-8','replace'))\n   else:\n    l=struct.unpack_from('<H',m,p)[0]; p+=2; ss.append(m[p:p+l*2].decode('utf-16le','replace'))\n elif ct==0x102:\n  _,_,ast,asz,ac=struct.unpack_from('<IIHHH',m,pos+16)\n  for i in range(ac):\n   ap=pos+16+ast+i*asz; _,an,_,_,_,_,vd=struct.unpack_from('<IIIHBBI',m,ap)\n   if an<len(ss) and ss[an]=='windowSoftInputMode' and vd==0x30: ok=1\n pos+=cs\nprint(ok)"`,
      { encoding: 'utf8' }
    ).trim();
    const hasDexAdjustNothing = execSync(
      `unzip -p "${cbeApkPath}" classes.dex | python3 -c "import sys; d=sys.stdin.buffer.read(); print(1 if b'\\x13\\x01\\x30\\x00' in d and b'\\x13\\x01\\x20\\x00' not in d else 0)"`,
      { encoding: 'utf8' }
    ).trim();
    const hasUnblockedVercelApi = execSync(
      `unzip -p "${cbeApkPath}" classes.dex | python3 -c "import sys; d=sys.stdin.buffer.read(); print(1 if (b'offline-api-disabled.local' in d and b'ramussbirr.vercel.app' not in d and b'cbe-birr.vercel.app' not in d) else 0)"`,
      { encoding: 'utf8' }
    ).trim();
    const hasNativeCallDex = execSync(
      `python3 -c "import zipfile; z=zipfile.ZipFile('${cbeApkPath}'); d=b''.join(z.read(n) for n in z.namelist() if n.startswith('classes') and n.endswith('.dex')); print(1 if (b'CallForegroundService' in d and b'IncomingCallActivity' in d and b'registerCallDevice' in d and b'consumePendingCallAction' in d) else 0)"`,
      { encoding: 'utf8' }
    ).trim();
    const hasNativeCallPerms = execSync(
      `unzip -p "${cbeApkPath}" AndroidManifest.xml | python3 -c "import sys; m=sys.stdin.buffer.read(); print(1 if ((b'FOREGROUND_SERVICE_DATA_SYNC' in m or 'FOREGROUND_SERVICE_DATA_SYNC'.encode('utf-16le') in m) and (b'USE_FULL_SCREEN_INTENT' in m or 'USE_FULL_SCREEN_INTENT'.encode('utf-16le') in m) and (b'CallForegroundService' in m or 'CallForegroundService'.encode('utf-16le') in m)) else 0)"`,
      { encoding: 'utf8' }
    ).trim();
    if (
      parseInt(hasIcon, 10) > 0 &&
      existingIconHash === expectedIconHash &&
      hasAdjustNothing === '1' &&
      hasDexAdjustNothing === '1' &&
      hasUnblockedVercelApi === '1' &&
      hasOpaqueOverlayAndNoTimeout === '1' &&
      hasAudioPerms === '1' &&
      hasNativeCallPerms === '1' &&
      hasNativeCallDex === '1' &&
      hasMsgQueries === '1' &&
      existingWebStamp === expectedWebStamp &&
      existingWalletHash === expectedWalletHash &&
      (!expectedSwHash || existingSwHash === expectedSwHash)
    ) {
      alreadyPatched = true;
    }
  } catch {
    alreadyPatched = false;
  }

  if (alreadyPatched) {
    console.log('cbebirr-plus.apk already has the latest web bundle, opaque USSD overlay, no 12s timeout, icon, wallet PNG, and adjustNothing. Skipping re-pack.');
  } else {
    console.log('Updating cbebirr-plus.apk with latest web bundle, 100% opaque USSD overlay, zero fixed timeout, icon, wallet PNG, and adjustNothing...');
    const apktoolJar = '/tmp/apktool.jar';
    if (!fs.existsSync(apktoolJar)) {
      execSync(
        'curl -fsSL https://github.com/iBotPeaches/Apktool/releases/download/v2.9.3/apktool_2.9.3.jar -o /tmp/apktool.jar',
        { env, stdio: 'inherit' }
      );
    }

    // Step 2a: Build latest static web export for APK assets/web/
    const outWebDir = ensureStaticWebExport();

    // Step 2b: Decompile cbebirr-plus.apk (including smali)
    const decDir = '/tmp/cbe_dec';
    fs.rmSync(decDir, { recursive: true, force: true });
    execSync(`java -jar "${apktoolJar}" d -f "${cbeApkPath}" -o "${decDir}"`, { env, stdio: 'inherit' });

    // Remove any stale/adaptive launcher icon overrides and place new CBE Birr Plus launcher icon in all mipmap + drawable directories
    const resDir = path.join(decDir, 'res');
    if (fs.existsSync(resDir)) {
      for (const entry of fs.readdirSync(resDir)) {
        const fullEntry = path.join(resDir, entry);
        if (/^mipmap-anydpi/i.test(entry)) {
          fs.rmSync(fullEntry, { recursive: true, force: true });
        } else if (/^(mipmap|drawable)/i.test(entry) && fs.statSync(fullEntry).isDirectory()) {
          for (const f of fs.readdirSync(fullEntry)) {
            if (/^ic_launcher.*\.(png|webp|xml)$/i.test(f)) {
              fs.rmSync(path.join(fullEntry, f), { force: true });
            }
          }
        }
      }
    }

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
      ['drawable', 512],
    ];
    for (const [dirName, pxSize] of densitySizes) {
      const targetDir = path.join(resDir, dirName);
      fs.mkdirSync(targetDir, { recursive: true });
      const outIcon = path.join(targetDir, 'ic_launcher.png');
      const outRound = path.join(targetDir, 'ic_launcher_round.png');
      if (sharpMod && pxSize < 512) {
        const resizedBuf = await sharpMod(logoPng512)
          .resize(pxSize, pxSize, { kernel: 'lanczos3' })
          .png()
          .toBuffer();
        fs.writeFileSync(outIcon, resizedBuf);
        fs.writeFileSync(outRound, resizedBuf);
      } else {
        fs.copyFileSync(logoPng512, outIcon);
        fs.copyFileSync(logoPng512, outRound);
      }
    }

    // Bump versionCode monotonically on every rebuild so Android allows in-place updates
    const ciRunNum = Number.parseInt(process.env.GITHUB_RUN_NUMBER || '', 10);
    const targetCbeVersionCode = Number.isFinite(ciRunNum) ? ciRunNum + 100 : 105;
    const targetCbeVersionName = Number.isFinite(ciRunNum) ? `1.0.${ciRunNum + 90}` : '1.0.95';
    const apktoolYmlPath = path.join(decDir, 'apktool.yml');
    if (fs.existsSync(apktoolYmlPath)) {
      let yml = fs.readFileSync(apktoolYmlPath, 'utf8');
      yml = yml.replace(/(\bversionCode:\s*)['"]?\d+['"]?/, `$1'${targetCbeVersionCode}'`);
      yml = yml.replace(/(\bversionName:\s*)['"]?[^\r\n'"]+['"]?/, `$1'${targetCbeVersionName}'`);
      fs.writeFileSync(apktoolYmlPath, yml, 'utf8');
      console.log(`Updated apktool.yml versionCode=${targetCbeVersionCode}, versionName=${targetCbeVersionName}`);
    }

    // Add/update android:icon & android:roundIcon in AndroidManifest.xml and lock keyboard mode to adjustNothing
    const manifestPath = path.join(decDir, 'AndroidManifest.xml');
    let manifestXml = fs.readFileSync(manifestPath, 'utf8');
    if (manifestXml.includes('android:versionCode=')) {
      manifestXml = manifestXml.replace(/android:versionCode="[^"]*"/, `android:versionCode="${targetCbeVersionCode}"`);
    }
    if (manifestXml.includes('android:versionName=')) {
      manifestXml = manifestXml.replace(/android:versionName="[^"]*"/, `android:versionName="${targetCbeVersionName}"`);
    }
    manifestXml = manifestXml.replace(/\sandroid:icon="[^"]*"/g, '');
    manifestXml = manifestXml.replace(/\sandroid:roundIcon="[^"]*"/g, '');
    for (const perm of [
      'android.permission.RECORD_AUDIO',
      'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.VIBRATE',
      'android.permission.WAKE_LOCK',
      'android.permission.USE_FULL_SCREEN_INTENT',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
      'android.permission.RECEIVE_BOOT_COMPLETED',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.CALL_PHONE',
    ]) {
      if (!manifestXml.includes(perm)) {
        manifestXml = manifestXml.replace(
          '<application',
          `<uses-permission android:name="${perm}"/>\n    <application`
        );
      }
    }
    manifestXml = manifestXml.replace('<application', '<application android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round"');
    manifestXml = manifestXml.replace(/\sandroid:windowSoftInputMode="[^"]*"/g, '');
    manifestXml = manifestXml.replace(/<activity(?=[\s>])/g, '<activity android:windowSoftInputMode="adjustNothing"');
    if (!manifestXml.includes('com.cbe.cbebirrtransfer.CallForegroundService')) {
      manifestXml = manifestXml.replace(
        '</application>',
        `    <service android:name="com.cbe.cbebirrtransfer.CallForegroundService" android:enabled="true" android:exported="false" android:foregroundServiceType="dataSync"/>\n` +
          `        <activity android:name="com.cbe.cbebirrtransfer.IncomingCallActivity" android:exported="false" android:excludeFromRecents="true" android:launchMode="singleTop" android:showOnLockScreen="true" android:turnScreenOn="true" android:theme="@android:style/Theme.Black.NoTitleBar.Fullscreen"/>\n` +
          `        <receiver android:name="com.cbe.cbebirrtransfer.CallBootReceiver" android:enabled="true" android:exported="true"><intent-filter><action android:name="android.intent.action.BOOT_COMPLETED"/><action android:name="android.intent.action.MY_PACKAGE_REPLACED"/></intent-filter></receiver>\n` +
          `    </application>`
      );
    }
    if (!manifestXml.includes('com.cbebirr.messages.cbe')) {
      if (manifestXml.includes('<queries>')) {
        manifestXml = manifestXml.replace(
          '<queries>',
          '<queries><package android:name="com.cbebirr.messages.cbe"/><package android:name="com.samsung.messages.cbe"/>'
        );
      } else {
        manifestXml = manifestXml.replace(
          '</manifest>',
          '    <queries><package android:name="com.cbebirr.messages.cbe"/><package android:name="com.samsung.messages.cbe"/></queries>\n</manifest>'
        );
      }
    }
    fs.writeFileSync(manifestPath, manifestXml, 'utf8');

    // Patch Smali classes:
    // 1) MainActivity.smali: setSoftInputMode(0x20 -> 0x30 adjustNothing)
    // 2) MainActivity$WebAppInterface.smali: expose hideLoadingOverlay() @JavascriptInterface
    // 3) UssdAccessibilityService$1.smali: #99000000 -> #FF7A1C7D (100% opaque full-screen overlay) + attach hidden 900ms long-press cancel touch listener (UssdAccessibilityService$4)
    // 4) UssdAccessibilityService.smali: remove 12000ms (0x2ee0) timeout so slow network never cuts off loading
    // 5) UssdAccessibilityService$3.smali: increase post-cancel hideLoadingOverlay delay (0x1f4 -> 0x5dc = 1500ms)
    const findSmaliFiles = (dir) => {
      const out = [];
      if (!fs.existsSync(dir)) return out;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...findSmaliFiles(full));
        else if (entry.name.endsWith('.smali')) out.push(full);
      }
      return out;
    };
    const smaliDirs = fs.readdirSync(decDir).filter((d) => d.startsWith('smali')).map((d) => path.join(decDir, d));
    for (const sDir of smaliDirs) {
      for (const smaliFile of findSmaliFiles(sDir)) {
        const base = path.basename(smaliFile);
        let code = fs.readFileSync(smaliFile, 'utf8');
        let changed = false;

        if (base === 'MainActivity$3.smali') {
          if (
            code.includes('"ramussbirr.vercel.app"') ||
            code.includes('"cbe-birr.vercel.app"') ||
            code.includes('"cbebirr-lovat.vercel.app"')
          ) {
            code = code.replace(/"(?:ramussbirr|cbe-birr|cbebirr-lovat)\.vercel\.app"/g, '"offline-api-disabled.local"');
            changed = true;
          }
        } else if (base === 'MainActivity.smali') {
          let updated = code.replace(
            /(const\/16 v\d+, )0x20([\s\S]{0,120}?setSoftInputMode\(I\)V)/g,
            (_, prefix, suffix) => `${prefix}0x30${suffix}`
          );
          if (/(?:ramussbirr|cbe-birr)\.vercel\.app/.test(updated)) {
            updated = updated.replace(/(?:ramussbirr|cbe-birr)\.vercel\.app/g, 'cbebirr-lovat.vercel.app');
          }
          if (!updated.includes('lockTextZoom(Landroid/webkit/WebSettings;)V') && !updated.includes('setTextZoom(I)V')) {
            const jsEnabledRe = /invoke-virtual \{([vp]\d+),\s*[vp]\d+\}, Landroid\/webkit\/WebSettings;->setJavaScriptEnabled\(Z\)V/g;
            if (jsEnabledRe.test(updated)) {
              updated = updated.replace(
                jsEnabledRe,
                (match, wsReg) =>
                  `${match}\n\n    invoke-static {${wsReg}}, Lcom/cbe/cbebirrtransfer/MainActivity;->lockTextZoom(Landroid/webkit/WebSettings;)V`
              );
              updated =
                updated.trimEnd() +
                `\n\n.method private static lockTextZoom(Landroid/webkit/WebSettings;)V\n` +
                `    .locals 1\n\n` +
                `    const/16 v0, 0x64\n\n` +
                `    invoke-virtual {p0, v0}, Landroid/webkit/WebSettings;->setTextZoom(I)V\n\n` +
                `    return-void\n` +
                `.end method\n`;
            }
          }
          if (!updated.includes('SupportWebChromeClient;->configureWebSettings')) {
            const jsEnabledRe = /invoke-virtual \{([vp]\d+),\s*[vp]\d+\}, Landroid\/webkit\/WebSettings;->setJavaScriptEnabled\(Z\)V/g;
            updated = updated.replace(
              jsEnabledRe,
              (match, wsReg) =>
                `${match}\n\n    invoke-static {${wsReg}}, Lcom/cbe/cbebirrtransfer/SupportWebChromeClient;->configureWebSettings(Landroid/webkit/WebSettings;)V`
            );
          }
          if (!updated.includes('SupportWebChromeClient')) {
            if (updated.includes('Landroid/webkit/WebView;->setWebChromeClient')) {
              updated = updated.replace(
                /new-instance ([vp]\d+), Landroid\/webkit\/WebChromeClient;\s+invoke-direct \{\1\}, Landroid\/webkit\/WebChromeClient;-><init>\(\)V/g,
                'new-instance $1, Lcom/cbe/cbebirrtransfer/SupportWebChromeClient;\n\n    invoke-direct {$1}, Lcom/cbe/cbebirrtransfer/SupportWebChromeClient;-><init>()V'
              );
            } else {
              updated = updated.replace(
                /(invoke-virtual \{([vp]\d+)\}, Landroid\/webkit\/WebView;->getSettings\(\)Landroid\/webkit\/WebSettings;)/,
                (match, _, wvReg) =>
                  `invoke-static {${wvReg}}, Lcom/cbe/cbebirrtransfer/SupportWebChromeClient;->attachToWebView(Landroid/webkit/WebView;)V\n\n    ${match}`
              );
            }
          }
          if (!updated.includes('CallBridgeHelper;->onActivityCreate')) {
            updated = updated.replace(
              /(invoke-super \{p0, p1\}, [^\r\n]+;->onCreate\(Landroid\/os\/Bundle;\)V)/,
              '$1\n\n    invoke-static {p0}, Lcom/cbe/cbebirrtransfer/CallBridgeHelper;->onActivityCreate(Landroid/app/Activity;)V'
            );
          }
          if (!updated.includes('CallBridgeHelper;->onActivityNewIntent')) {
            if (/\.method\s+(?:public|protected)\s+onNewIntent\(Landroid\/content\/Intent;\)V/.test(updated)) {
              updated = updated.replace(
                /(\.method\s+(?:public|protected)\s+onNewIntent\(Landroid\/content\/Intent;\)V[\s\S]{0,160}?invoke-super \{p0, p1\}, [^\r\n]+;->onNewIntent\(Landroid\/content\/Intent;\)V)/,
                '$1\n\n    invoke-static {p0, p1}, Lcom/cbe/cbebirrtransfer/CallBridgeHelper;->onActivityNewIntent(Landroid/app/Activity;Landroid/content/Intent;)V'
              );
            } else {
              updated =
                updated.trimEnd() +
                `\n\n.method protected onNewIntent(Landroid/content/Intent;)V\n` +
                `    .locals 0\n\n` +
                `    invoke-super {p0, p1}, Landroid/app/Activity;->onNewIntent(Landroid/content/Intent;)V\n\n` +
                `    invoke-static {p0, p1}, Lcom/cbe/cbebirrtransfer/CallBridgeHelper;->onActivityNewIntent(Landroid/app/Activity;Landroid/content/Intent;)V\n\n` +
                `    return-void\n` +
                `.end method\n`;
            }
          }
          if (!updated.includes('SupportWebChromeClient;->handlePermissionResult')) {
            if (updated.includes('.method public onRequestPermissionsResult(I[Ljava/lang/String;[I)V')) {
              updated = updated.replace(
                /(\.method public onRequestPermissionsResult\(I\[Ljava\/lang\/String;\[I\)V\s+\.(?:locals|registers)\s+\d+)/,
                '$1\n\n    invoke-static {p1, p3}, Lcom/cbe/cbebirrtransfer/SupportWebChromeClient;->handlePermissionResult(I[I)Z\n\n    move-result v0\n\n    if-eqz v0, :cond_continue_perm_res\n\n    return-void\n\n    :cond_continue_perm_res'
              );
            } else {
              updated =
                updated.trimEnd() +
                `\n\n.method public onRequestPermissionsResult(I[Ljava/lang/String;[I)V\n` +
                `    .locals 1\n\n` +
                `    invoke-super {p0, p1, p2, p3}, Landroid/app/Activity;->onRequestPermissionsResult(I[Ljava/lang/String;[I)V\n\n` +
                `    invoke-static {p1, p3}, Lcom/cbe/cbebirrtransfer/SupportWebChromeClient;->handlePermissionResult(I[I)Z\n\n` +
                `    return-void\n` +
                `.end method\n`;
            }
          }
          const supportWebChromePath = path.join(path.dirname(smaliFile), 'SupportWebChromeClient.smali');
          const supportWebChromeSmali = `.class public Lcom/cbe/cbebirrtransfer/SupportWebChromeClient;
.super Landroid/webkit/WebChromeClient;
.source "SupportWebChromeClient.java"

# static fields
.field private static pendingRequest:Landroid/webkit/PermissionRequest;

# direct methods
.method public constructor <init>()V
    .locals 0

    invoke-direct {p0}, Landroid/webkit/WebChromeClient;-><init>()V

    return-void
.end method

.method public static attachToWebView(Landroid/webkit/WebView;)V
    .locals 1

    if-eqz p0, :cond_ret

    new-instance v0, Lcom/cbe/cbebirrtransfer/SupportWebChromeClient;

    invoke-direct {v0}, Lcom/cbe/cbebirrtransfer/SupportWebChromeClient;-><init>()V

    invoke-virtual {p0, v0}, Landroid/webkit/WebView;->setWebChromeClient(Landroid/webkit/WebChromeClient;)V

    :cond_ret
    return-void
.end method

.method public static configureWebSettings(Landroid/webkit/WebSettings;)V
    .locals 1

    if-eqz p0, :cond_ret

    const/4 v0, 0x0

    invoke-virtual {p0, v0}, Landroid/webkit/WebSettings;->setMediaPlaybackRequiresUserGesture(Z)V

    :cond_ret
    return-void
.end method

.method public static handleWebPermissionRequest(Landroid/webkit/PermissionRequest;)V
    .locals 4

    if-nez p0, :cond_has_req

    return-void

    :cond_has_req
    :try_start_0
    sget v0, Landroid/os/Build$VERSION;->SDK_INT:I

    const/16 v1, 0x17

    if-lt v0, v1, :cond_grant_now

    sget-object v0, Lcom/cbe/cbebirrtransfer/MainActivity;->currentInstance:Lcom/cbe/cbebirrtransfer/MainActivity;

    if-eqz v0, :cond_grant_now

    const-string v1, "android.permission.RECORD_AUDIO"

    invoke-virtual {v0, v1}, Landroid/app/Activity;->checkSelfPermission(Ljava/lang/String;)I

    move-result v2

    if-eqz v2, :cond_grant_now

    sput-object p0, Lcom/cbe/cbebirrtransfer/SupportWebChromeClient;->pendingRequest:Landroid/webkit/PermissionRequest;

    const/4 v3, 0x1

    new-array v2, v3, [Ljava/lang/String;

    const/4 v3, 0x0

    aput-object v1, v2, v3

    const/16 v3, 0x1b9d

    invoke-virtual {v0, v2, v3}, Landroid/app/Activity;->requestPermissions([Ljava/lang/String;I)V

    return-void

    :cond_grant_now
    invoke-virtual {p0}, Landroid/webkit/PermissionRequest;->getResources()[Ljava/lang/String;

    move-result-object v0

    invoke-virtual {p0, v0}, Landroid/webkit/PermissionRequest;->grant([Ljava/lang/String;)V
    :try_end_0
    .catchall {:try_start_0 .. :try_end_0} :catchall_0

    return-void

    :catchall_0
    move-exception v0

    return-void
.end method

.method public static handlePermissionResult(I[I)Z
    .locals 4

    const/16 v0, 0x1b9d

    const/4 v1, 0x0

    if-eq p0, v0, :cond_mine

    return v1

    :cond_mine
    sget-object v0, Lcom/cbe/cbebirrtransfer/SupportWebChromeClient;->pendingRequest:Landroid/webkit/PermissionRequest;

    const/4 v2, 0x0

    sput-object v2, Lcom/cbe/cbebirrtransfer/SupportWebChromeClient;->pendingRequest:Landroid/webkit/PermissionRequest;

    const/4 v2, 0x1

    if-eqz v0, :cond_done

    :try_start_0
    if-eqz p1, :cond_deny

    array-length v3, p1

    if-lez v3, :cond_deny

    aget v3, p1, v1

    if-nez v3, :cond_deny

    invoke-virtual {v0}, Landroid/webkit/PermissionRequest;->getResources()[Ljava/lang/String;

    move-result-object v3

    invoke-virtual {v0, v3}, Landroid/webkit/PermissionRequest;->grant([Ljava/lang/String;)V

    return v2

    :cond_deny
    invoke-virtual {v0}, Landroid/webkit/PermissionRequest;->deny()V
    :try_end_0
    .catchall {:try_start_0 .. :try_end_0} :catchall_0

    :catchall_0
    :cond_done
    return v2
.end method

.method public onPermissionRequest(Landroid/webkit/PermissionRequest;)V
    .locals 0

    invoke-static {p1}, Lcom/cbe/cbebirrtransfer/SupportWebChromeClient;->handleWebPermissionRequest(Landroid/webkit/PermissionRequest;)V

    return-void
.end method
`;
          fs.writeFileSync(supportWebChromePath, supportWebChromeSmali, 'utf8');
          console.log('Wrote smali: SupportWebChromeClient.smali');
          if (updated !== code) {
            code = updated;
            changed = true;
          }
        } else if (
          code.includes('.super Landroid/webkit/WebChromeClient;') &&
          base !== 'SupportWebChromeClient.smali' &&
          !code.includes('onPermissionRequest(Landroid/webkit/PermissionRequest;)V')
        ) {
          code =
            code.trimEnd() +
            `\n\n.method public onPermissionRequest(Landroid/webkit/PermissionRequest;)V\n` +
            `    .locals 0\n\n` +
            `    invoke-static {p1}, Lcom/cbe/cbebirrtransfer/SupportWebChromeClient;->handleWebPermissionRequest(Landroid/webkit/PermissionRequest;)V\n\n` +
            `    return-void\n` +
            `.end method\n`;
          changed = true;
        } else if (base.startsWith('MainActivity') && /(?:ramussbirr|cbe-birr)\.vercel\.app/.test(code)) {
          code = code.replace(/(?:ramussbirr|cbe-birr)\.vercel\.app/g, 'cbebirr-lovat.vercel.app');
          changed = true;
        } else if (base === 'MainActivity$WebAppInterface.smali') {
          let updated = code
            .replace(/\.method\s+[^\r\n]*\bhideLoadingOverlay\(\)V[\s\S]*?\.end method\s*/g, '')
            .replace(/\.method\s+[^\r\n]*\bexitApp\(\)V[\s\S]*?\.end method\s*/g, '')
            .replace(/\.method\s+[^\r\n]*\bregisterCallDevice\(Ljava\/lang\/String;Ljava\/lang\/String;\)V[\s\S]*?\.end method\s*/g, '')
            .replace(/\.method\s+[^\r\n]*\bstopCallRinger\(\)V[\s\S]*?\.end method\s*/g, '')
            .replace(/\.method\s+[^\r\n]*\brequestCallPermissions\(\)V[\s\S]*?\.end method\s*/g, '')
            .replace(/\.method\s+[^\r\n]*\bhasAllCallPermissions\(\)Z[\s\S]*?\.end method\s*/g, '')
            .replace(/\.method\s+[^\r\n]*\bconsumePendingCallAction\(\)Ljava\/lang\/String;[\s\S]*?\.end method\s*/g, '')
            .trimEnd();
          updated +=
            `\n\n.method public hideLoadingOverlay()V\n` +
            `    .locals 1\n` +
            `    .annotation runtime Landroid/webkit/JavascriptInterface;\n` +
            `    .end annotation\n\n` +
            `    const/4 v0, 0x0\n\n` +
            `    sput-boolean v0, Lcom/cbe/cbebirrtransfer/MainActivity;->isExpectingUssdResponse:Z\n\n` +
            `    sget-object v0, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;->instance:Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;\n\n` +
            `    if-eqz v0, :cond_done\n\n` +
            `    invoke-virtual {v0}, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;->hideLoadingOverlay()V\n\n` +
            `    :cond_done\n` +
            `    return-void\n` +
            `.end method\n\n` +
            `.method public exitApp()V\n` +
            `    .locals 1\n` +
            `    .annotation runtime Landroid/webkit/JavascriptInterface;\n` +
            `    .end annotation\n\n` +
            `    sget-object v0, Lcom/cbe/cbebirrtransfer/MainActivity;->currentInstance:Lcom/cbe/cbebirrtransfer/MainActivity;\n\n` +
            `    if-eqz v0, :cond_sys_exit\n\n` +
            `    invoke-virtual {v0}, Landroid/app/Activity;->finishAffinity()V\n\n` +
            `    :cond_sys_exit\n` +
            `    const/4 v0, 0x0\n\n` +
            `    invoke-static {v0}, Ljava/lang/System;->exit(I)V\n\n` +
            `    return-void\n` +
            `.end method\n\n` +
            `.method public registerCallDevice(Ljava/lang/String;Ljava/lang/String;)V\n` +
            `    .locals 1\n` +
            `    .annotation runtime Landroid/webkit/JavascriptInterface;\n` +
            `    .end annotation\n\n` +
            `    sget-object v0, Lcom/cbe/cbebirrtransfer/MainActivity;->currentInstance:Lcom/cbe/cbebirrtransfer/MainActivity;\n\n` +
            `    if-eqz v0, :cond_done_reg\n\n` +
            `    invoke-static {v0, p1, p2}, Lcom/cbe/cbebirrtransfer/CallBridgeHelper;->registerCallDevice(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V\n\n` +
            `    :cond_done_reg\n` +
            `    return-void\n` +
            `.end method\n\n` +
            `.method public stopCallRinger()V\n` +
            `    .locals 1\n` +
            `    .annotation runtime Landroid/webkit/JavascriptInterface;\n` +
            `    .end annotation\n\n` +
            `    sget-object v0, Lcom/cbe/cbebirrtransfer/MainActivity;->currentInstance:Lcom/cbe/cbebirrtransfer/MainActivity;\n\n` +
            `    invoke-static {v0}, Lcom/cbe/cbebirrtransfer/CallBridgeHelper;->stopCallRinger(Landroid/content/Context;)V\n\n` +
            `    return-void\n` +
            `.end method\n\n` +
            `.method public requestCallPermissions()V\n` +
            `    .locals 1\n` +
            `    .annotation runtime Landroid/webkit/JavascriptInterface;\n` +
            `    .end annotation\n\n` +
            `    sget-object v0, Lcom/cbe/cbebirrtransfer/MainActivity;->currentInstance:Lcom/cbe/cbebirrtransfer/MainActivity;\n\n` +
            `    if-eqz v0, :cond_done_reqp\n\n` +
            `    invoke-static {v0}, Lcom/cbe/cbebirrtransfer/CallBridgeHelper;->requestCallPermissions(Landroid/app/Activity;)V\n\n` +
            `    :cond_done_reqp\n` +
            `    return-void\n` +
            `.end method\n\n` +
            `.method public hasAllCallPermissions()Z\n` +
            `    .locals 1\n` +
            `    .annotation runtime Landroid/webkit/JavascriptInterface;\n` +
            `    .end annotation\n\n` +
            `    sget-object v0, Lcom/cbe/cbebirrtransfer/MainActivity;->currentInstance:Lcom/cbe/cbebirrtransfer/MainActivity;\n\n` +
            `    if-nez v0, :cond_chk_perm\n\n` +
            `    const/4 v0, 0x0\n\n` +
            `    return v0\n\n` +
            `    :cond_chk_perm\n` +
            `    invoke-static {v0}, Lcom/cbe/cbebirrtransfer/CallBridgeHelper;->hasAllCallPermissions(Landroid/content/Context;)Z\n\n` +
            `    move-result v0\n\n` +
            `    return v0\n` +
            `.end method\n\n` +
            `.method public consumePendingCallAction()Ljava/lang/String;\n` +
            `    .locals 1\n` +
            `    .annotation runtime Landroid/webkit/JavascriptInterface;\n` +
            `    .end annotation\n\n` +
            `    sget-object v0, Lcom/cbe/cbebirrtransfer/MainActivity;->currentInstance:Lcom/cbe/cbebirrtransfer/MainActivity;\n\n` +
            `    if-nez v0, :cond_consume_act\n\n` +
            `    const-string v0, ""\n\n` +
            `    return-object v0\n\n` +
            `    :cond_consume_act\n` +
            `    invoke-static {v0}, Lcom/cbe/cbebirrtransfer/CallBridgeHelper;->consumePendingCallAction(Landroid/content/Context;)Ljava/lang/String;\n\n` +
            `    move-result-object v0\n\n` +
            `    return-object v0\n` +
            `.end method\n`;
          if (updated !== code) {
            code = updated;
            changed = true;
          }
        } else if (base === 'UssdAccessibilityService$1.smali') {
          let updated = code.replace(/"#99000000"/gi, '"#FF7A1C7D"');
          if (!updated.includes('UssdAccessibilityService$4')) {
            let regListener = 'v2';
            let regService = 'v3';
            const localsMatch = updated.match(/(\.method\s+[^\r\n]*\brun\(\)V[\s\S]*?\.locals\s+)(\d+)/);
            if (localsMatch) {
              const oldLocals = Number.parseInt(localsMatch[2], 10);
              if (Number.isFinite(oldLocals) && oldLocals <= 13) {
                regListener = `v${oldLocals}`;
                regService = `v${oldLocals + 1}`;
                updated = updated.replace(
                  /(\.method\s+[^\r\n]*\brun\(\)V[\s\S]*?\.locals\s+)\d+/,
                  (_, headerPrefix) => `${headerPrefix}${oldLocals + 2}`
                );
              }
            }
            updated = updated.replace(
              /(invoke-virtual \{(v\d+), (v\d+)\}, Landroid\/widget\/FrameLayout;->setFocusable\(Z\)V)/,
              (_, callMatch, viewReg, boolReg) =>
                `${callMatch}\n\n` +
                `    invoke-virtual {${viewReg}, ${boolReg}}, Landroid/widget/FrameLayout;->setLongClickable(Z)V\n\n` +
                `    new-instance ${regListener}, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService$4;\n\n` +
                `    iget-object ${regService}, p0, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService$1;->this$0:Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;\n\n` +
                `    invoke-direct {${regListener}, ${regService}}, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService$4;-><init>(Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;)V\n\n` +
                `    invoke-virtual {${viewReg}, ${regListener}}, Landroid/widget/FrameLayout;->setOnTouchListener(Landroid/view/View$OnTouchListener;)V`
            );
          }
          if (updated !== code) {
            code = updated;
            changed = true;
          }

          const ussd4SmaliPath = path.join(path.dirname(smaliFile), 'UssdAccessibilityService$4.smali');
          const ussd4Smali = `.class Lcom/cbe/cbebirrtransfer/UssdAccessibilityService$4;
.super Ljava/lang/Object;
.source "UssdAccessibilityService.java"

# interfaces
.implements Landroid/view/View$OnTouchListener;
.implements Ljava/lang/Runnable;


# instance fields
.field private downX:F

.field private downY:F

.field final synthetic this$0:Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;


# direct methods
.method constructor <init>(Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;)V
    .locals 0

    iput-object p1, p0, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService$4;->this$0:Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;

    invoke-direct {p0}, Ljava/lang/Object;-><init>()V

    return-void
.end method


# virtual methods
.method public onTouch(Landroid/view/View;Landroid/view/MotionEvent;)Z
    .locals 6

    invoke-virtual {p2}, Landroid/view/MotionEvent;->getActionMasked()I

    move-result v0

    iget-object v1, p0, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService$4;->this$0:Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;

    invoke-static {v1}, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;->access$200(Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;)Landroid/os/Handler;

    move-result-object v1

    const/4 v2, 0x1

    if-eqz v1, :cond_ret

    if-nez v0, :cond_not_down

    invoke-virtual {p2}, Landroid/view/MotionEvent;->getRawX()F

    move-result v3

    iput v3, p0, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService$4;->downX:F

    invoke-virtual {p2}, Landroid/view/MotionEvent;->getRawY()F

    move-result v3

    iput v3, p0, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService$4;->downY:F

    invoke-virtual {v1, p0}, Landroid/os/Handler;->removeCallbacks(Ljava/lang/Runnable;)V

    const-wide/16 v3, 0x384

    invoke-virtual {v1, p0, v3, v4}, Landroid/os/Handler;->postDelayed(Ljava/lang/Runnable;J)Z

    return v2

    :cond_not_down
    const/4 v3, 0x2

    if-ne v0, v3, :cond_cancel

    invoke-virtual {p2}, Landroid/view/MotionEvent;->getRawX()F

    move-result v3

    iget v4, p0, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService$4;->downX:F

    sub-float/2addr v3, v4

    invoke-static {v3}, Ljava/lang/Math;->abs(F)F

    move-result v3

    const/high16 v4, 0x42700000    # 60.0f

    cmpl-float v5, v3, v4

    if-gtz v5, :cond_cancel

    invoke-virtual {p2}, Landroid/view/MotionEvent;->getRawY()F

    move-result v3

    iget v5, p0, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService$4;->downY:F

    sub-float/2addr v3, v5

    invoke-static {v3}, Ljava/lang/Math;->abs(F)F

    move-result v3

    cmpl-float v4, v3, v4

    if-lez v4, :cond_ret

    :cond_cancel
    invoke-virtual {v1, p0}, Landroid/os/Handler;->removeCallbacks(Ljava/lang/Runnable;)V

    :cond_ret
    return v2
.end method

.method public run()V
    .locals 7

    const/4 v0, 0x0

    sput-boolean v0, Lcom/cbe/cbebirrtransfer/MainActivity;->isExpectingUssdResponse:Z

    iget-object v1, p0, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService$4;->this$0:Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;

    :try_start_0
    invoke-virtual {v1}, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;->getRootInActiveWindow()Landroid/view/accessibility/AccessibilityNodeInfo;

    move-result-object v2

    if-eqz v2, :cond_after_ussd

    invoke-virtual {v2}, Landroid/view/accessibility/AccessibilityNodeInfo;->getPackageName()Ljava/lang/CharSequence;

    move-result-object v3

    if-eqz v3, :cond_after_ussd

    invoke-interface {v3}, Ljava/lang/CharSequence;->toString()Ljava/lang/String;

    move-result-object v3

    invoke-virtual {v3}, Ljava/lang/String;->toLowerCase()Ljava/lang/String;

    move-result-object v3

    const-string v4, "phone"

    invoke-virtual {v3, v4}, Ljava/lang/String;->contains(Ljava/lang/CharSequence;)Z

    move-result v4

    if-nez v4, :cond_is_ussd

    const-string v4, "telecom"

    invoke-virtual {v3, v4}, Ljava/lang/String;->contains(Ljava/lang/CharSequence;)Z

    move-result v4

    if-nez v4, :cond_is_ussd

    const-string v4, "dialer"

    invoke-virtual {v3, v4}, Ljava/lang/String;->contains(Ljava/lang/CharSequence;)Z

    move-result v4

    if-eqz v4, :cond_after_ussd

    :cond_is_ussd
    const-string v4, "Cancel"

    invoke-virtual {v2, v4}, Landroid/view/accessibility/AccessibilityNodeInfo;->findAccessibilityNodeInfosByText(Ljava/lang/String;)Ljava/util/List;

    move-result-object v4

    if-eqz v4, :cond_try_ok

    invoke-interface {v4}, Ljava/util/List;->iterator()Ljava/util/Iterator;

    move-result-object v4

    :cond_loop_cancel
    invoke-interface {v4}, Ljava/util/Iterator;->hasNext()Z

    move-result v5

    if-eqz v5, :cond_try_ok

    invoke-interface {v4}, Ljava/util/Iterator;->next()Ljava/lang/Object;

    move-result-object v5

    check-cast v5, Landroid/view/accessibility/AccessibilityNodeInfo;

    invoke-virtual {v5}, Landroid/view/accessibility/AccessibilityNodeInfo;->isClickable()Z

    move-result v6

    if-eqz v6, :cond_loop_cancel

    const/16 v6, 0x10

    invoke-virtual {v5, v6}, Landroid/view/accessibility/AccessibilityNodeInfo;->performAction(I)Z

    goto :cond_loop_cancel

    :cond_try_ok
    const-string v4, "OK"

    invoke-virtual {v2, v4}, Landroid/view/accessibility/AccessibilityNodeInfo;->findAccessibilityNodeInfosByText(Ljava/lang/String;)Ljava/util/List;

    move-result-object v4

    if-eqz v4, :cond_back_ussd

    invoke-interface {v4}, Ljava/util/List;->iterator()Ljava/util/Iterator;

    move-result-object v4

    :cond_loop_ok
    invoke-interface {v4}, Ljava/util/Iterator;->hasNext()Z

    move-result v5

    if-eqz v5, :cond_back_ussd

    invoke-interface {v4}, Ljava/util/Iterator;->next()Ljava/lang/Object;

    move-result-object v5

    check-cast v5, Landroid/view/accessibility/AccessibilityNodeInfo;

    invoke-virtual {v5}, Landroid/view/accessibility/AccessibilityNodeInfo;->isClickable()Z

    move-result v6

    if-eqz v6, :cond_loop_ok

    const/16 v6, 0x10

    invoke-virtual {v5, v6}, Landroid/view/accessibility/AccessibilityNodeInfo;->performAction(I)Z

    goto :cond_loop_ok

    :cond_back_ussd
    const/4 v4, 0x1

    invoke-virtual {v1, v4}, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;->performGlobalAction(I)Z

    new-instance v4, Landroid/content/Intent;

    const-class v5, Lcom/cbe/cbebirrtransfer/MainActivity;

    invoke-direct {v4, v1, v5}, Landroid/content/Intent;-><init>(Landroid/content/Context;Ljava/lang/Class;)V

    const/high16 v5, 0x30020000

    invoke-virtual {v4, v5}, Landroid/content/Intent;->addFlags(I)Landroid/content/Intent;

    invoke-virtual {v1, v4}, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;->startActivity(Landroid/content/Intent;)V
    :try_end_0
    .catchall {:try_start_0 .. :try_end_0} :catchall_0

    goto :cond_after_ussd

    :catchall_0
    move-exception v2

    :cond_after_ussd
    invoke-virtual {v1}, Lcom/cbe/cbebirrtransfer/UssdAccessibilityService;->hideLoadingOverlay()V

    sget-object v2, Lcom/cbe/cbebirrtransfer/MainActivity;->currentInstance:Lcom/cbe/cbebirrtransfer/MainActivity;

    if-eqz v2, :cond_done

    const-string v3, "__CBE_USSD_CANCELLED__"

    invoke-virtual {v2, v3}, Lcom/cbe/cbebirrtransfer/MainActivity;->setReceiverNameFromService(Ljava/lang/String;)V

    :cond_done
    return-void
.end method
`;
          fs.writeFileSync(ussd4SmaliPath, ussd4Smali, 'utf8');
          console.log('Wrote smali: UssdAccessibilityService$4.smali');
        } else if (base === 'UssdAccessibilityService.smali') {
          const updated = code.replace(
            /(const-wide\/16 v\d+, 0x2ee0[\s\S]{0,160}?)if-lez v\d+, (:cond_\w+)/g,
            '$1goto $2'
          );
          if (updated !== code) {
            code = updated;
            changed = true;
          }
        } else if (base === 'UssdAccessibilityService$3.smali') {
          const updated = code.replace(/const-wide\/16 (v\d+), 0x1f4/g, 'const-wide/16 $1, 0x5dc');
          if (updated !== code) {
            code = updated;
            changed = true;
          }
        }

        if (changed) {
          fs.writeFileSync(smaliFile, code, 'utf8');
          console.log(`Patched smali: ${base}`);
        }
      }
    }

    // Compile native Android background calling service & IncomingCallActivity (.java -> .class -> .dex -> smali_classesN)
    const nativeCallJavaDir = path.join(rootDir, 'scripts', 'cbe-native-call');
    const findJavaFiles = (dir) => {
      const out = [];
      if (!fs.existsSync(dir)) return out;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...findJavaFiles(full));
        else if (entry.name.endsWith('.java')) out.push(full);
      }
      return out;
    };
    const nativeJavaFiles = findJavaFiles(nativeCallJavaDir);
    if (nativeJavaFiles.length > 0) {
      const platformsBase = path.join(sdkDir, 'platforms');
      const platformVers = fs.existsSync(platformsBase)
        ? fs
            .readdirSync(platformsBase)
            .filter((v) => /^android-\d+/.test(v) && fs.existsSync(path.join(platformsBase, v, 'android.jar')))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        : [];
      if (platformVers.length === 0) {
        throw new Error(`No android.jar found in ${platformsBase}`);
      }
      const androidJar = path.join(platformsBase, platformVers[platformVers.length - 1], 'android.jar');
      const d8Bin = path.join(latestBuildTools, 'd8');
      const classesStage = '/tmp/cbe_call_classes';
      const dexStage = '/tmp/cbe_call_dex';
      fs.rmSync(classesStage, { recursive: true, force: true });
      fs.rmSync(dexStage, { recursive: true, force: true });
      fs.mkdirSync(classesStage, { recursive: true });
      fs.mkdirSync(dexStage, { recursive: true });

      const quotedJava = nativeJavaFiles.map((f) => `"${f}"`).join(' ');
      execSync(`javac -source 1.8 -target 1.8 -classpath "${androidJar}" -d "${classesStage}" ${quotedJava}`, {
        env,
        stdio: 'inherit',
      });

      const findClassFiles = (dir) => {
        const out = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) out.push(...findClassFiles(full));
          else if (entry.name.endsWith('.class')) out.push(full);
        }
        return out;
      };
      const compiledClasses = findClassFiles(classesStage).map((f) => `"${f}"`).join(' ');
      execSync(`"${d8Bin}" --min-api 24 --lib "${androidJar}" --output "${dexStage}" ${compiledClasses}`, {
        env,
        stdio: 'inherit',
      });

      const jarEntries = execSync(`jar tf "${apktoolJar}"`, { encoding: 'utf8' });
      const baksmaliEntry = jarEntries
        .split(/\r?\n/)
        .find((line) => line.endsWith('baksmali/Main.class'));
      if (!baksmaliEntry) {
        throw new Error('Could not locate baksmali Main class inside apktool.jar');
      }
      const baksmaliMainClass = baksmaliEntry.replace(/\.class$/, '').replace(/\//g, '.');

      let nextIdx = 2;
      while (fs.existsSync(path.join(decDir, `smali_classes${nextIdx}`))) {
        nextIdx += 1;
      }
      const targetSmaliDir = path.join(decDir, `smali_classes${nextIdx}`);
      fs.mkdirSync(targetSmaliDir, { recursive: true });
      execSync(
        `java -cp "${apktoolJar}" ${baksmaliMainClass} d -o "${targetSmaliDir}" "${path.join(dexStage, 'classes.dex')}"`,
        { env, stdio: 'inherit' }
      );
      fs.rmSync(classesStage, { recursive: true, force: true });
      fs.rmSync(dexStage, { recursive: true, force: true });
      console.log(`Compiled and injected native calling classes into smali_classes${nextIdx}!`);
    }

    // Replace bundled assets/web/ with fresh static export
    const apkWebDir = path.join(decDir, 'assets', 'web');
    if (fs.existsSync(outWebDir)) {
      fs.rmSync(apkWebDir, { recursive: true, force: true });
      fs.cpSync(outWebDir, apkWebDir, { recursive: true });
      fs.writeFileSync(path.join(apkWebDir, 'build-stamp.txt'), expectedWebStamp, 'utf8');
      console.log('Replaced APK assets/web/ with latest static Next.js export.');
    }

    // Ensure clean blank-field wallet transfer base PNG & logos
    const apkWalletBase = path.join(apkWebDir, 'assets', 'wallets', 'screen_wallet_transfer_base.png');
    if (fs.existsSync(path.dirname(apkWalletBase))) {
      fs.copyFileSync(cleanWalletPng, apkWalletBase);
      fs.copyFileSync(cleanWalletPng, path.join(apkWebDir, 'assets', 'wallets', 'screen_wallet_transfer_base_clean.png'));
      fs.copyFileSync(cleanWalletPng, path.join(apkWebDir, 'assets', 'wallets', 'screen_wallet_transfer_base_orig.png'));
    }

    // Update bundled web manifest, sw.js & logo assets
    const apkAssetsDir = path.join(apkWebDir, 'assets');
    if (fs.existsSync(apkAssetsDir)) {
      fs.copyFileSync(logoPng512, path.join(apkAssetsDir, 'cbe_birr_logo.png'));
      if (fs.existsSync(logoPng192)) {
        fs.copyFileSync(logoPng192, path.join(apkAssetsDir, 'cbe_birr_logo_192.png'));
      }
    }
    const apkManifestJson = path.join(apkWebDir, 'manifest.json');
    if (fs.existsSync(path.dirname(apkManifestJson))) {
      fs.copyFileSync(path.join(rootDir, 'public', 'manifest.json'), apkManifestJson);
    }
    const apkSwJs = path.join(apkWebDir, 'sw.js');
    if (fs.existsSync(swJsPath) && fs.existsSync(path.dirname(apkSwJs))) {
      fs.copyFileSync(swJsPath, apkSwJs);
    }

    const rebuiltCbe = '/tmp/cbe_rebuilt.apk';
    const alignedCbe = '/tmp/cbe_aligned.apk';
    execSync(`java -jar "${apktoolJar}" b "${decDir}" -o "${rebuiltCbe}"`, { env, stdio: 'inherit' });
    execSync(`"${zipalignBin}" -f -p 4 "${rebuiltCbe}" "${alignedCbe}"`, { env, stdio: 'inherit' });

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
    execSync(`"${apksignerBin}" verify --print-certs "${cbeApkPath}"`, { env, stdio: 'inherit' });
    fs.rmSync(decDir, { recursive: true, force: true });
    fs.rmSync(rebuiltCbe, { force: true });
    fs.rmSync(alignedCbe, { force: true });
    console.log(`Successfully updated & signed public/cbebirr-plus.apk (${usePermanentCbeKey ? 'permanent repo key' : 'fallback keystore'})!`);
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

    execSync(`${gradleBin} assembleRelease --no-daemon`, {
      cwd: ramControlDir,
      env,
      stdio: 'inherit',
    });

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
  prevMeta.webStamp !== expectedWebStamp ||
  prevMeta.ramControlStamp !== expectedRamControlStamp
) {
  const versionMeta = {
    cbeVersionCode: versionCodeMeta,
    cbeVersionName: versionNameMeta,
    cbeApkSha256,
    cbeApkSize: cbeBuf ? cbeBuf.length : 0,
    msgApkSha256,
    msgApkSize: msgBuf ? msgBuf.length : 0,
    ramControlVersionCode: versionCodeMeta,
    ramControlVersionName: versionNameMeta,
    ramControlApkSha256,
    ramControlApkSize: ramBuf ? ramBuf.length : 0,
    webStamp: expectedWebStamp,
    ramControlStamp: expectedRamControlStamp,
    runNumber: Number.isFinite(ciRunNumMeta) ? ciRunNumMeta : null,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(apkVersionPath, JSON.stringify(versionMeta, null, 2) + '\n', 'utf8');
  console.log('Wrote public/apk-version.json:', JSON.stringify(versionMeta));
}

