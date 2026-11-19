import { NextRequest } from 'next/server';
import { readApkMeta, serveApkResponse } from '@/lib/apkDownload';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function getVersionTag(appType: 'cbe' | 'ramcontrol' | 'messages'): string {
  const meta = readApkMeta();
  const sha = (
    appType === 'cbe'
      ? meta?.cbeApkSha256
      : appType === 'ramcontrol'
      ? meta?.ramControlApkSha256
      : meta?.msgApkSha256
  )?.slice(0, 12);
  return sha ? `${meta?.cbeVersionCode || 'v'}-${sha}` : String(Date.now());
}

function resolveAppTarget(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const targetApp = (searchParams.get('app') || 'messages').toLowerCase();
  const appType: 'cbe' | 'ramcontrol' | 'messages' =
    targetApp === 'cbe' || targetApp === 'cbebirr' || targetApp === 'banking'
      ? 'cbe'
      : targetApp === 'ramcontrol' || targetApp === 'ram-control' || targetApp === 'owner'
      ? 'ramcontrol'
      : 'messages';
  const localFilename =
    appType === 'cbe'
      ? 'cbebirr-plus.apk'
      : appType === 'ramcontrol'
      ? 'RamControl.apk'
      : 'CBEMessages.apk';
  const downloadFilename =
    appType === 'cbe'
      ? 'CBEBirrPlus.apk'
      : appType === 'ramcontrol'
      ? 'RamControl.apk'
      : 'CBEMessages.apk';
  return { appType, localFilename, downloadFilename };
}

export async function GET(req: NextRequest) {
  const { appType, localFilename, downloadFilename } = resolveAppTarget(req);
  return serveApkResponse({
    localFilename,
    downloadFilename,
    versionTag: getVersionTag(appType),
    method: 'GET',
  });
}

export async function HEAD(req: NextRequest) {
  const { appType, localFilename, downloadFilename } = resolveAppTarget(req);
  return serveApkResponse({
    localFilename,
    downloadFilename,
    versionTag: getVersionTag(appType),
    method: 'HEAD',
  });
}
