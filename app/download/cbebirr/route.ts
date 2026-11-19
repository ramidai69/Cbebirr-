import { readApkMeta, serveApkResponse } from '@/lib/apkDownload';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function getCbeVersionTag(): string {
  const meta = readApkMeta();
  const sha = (meta?.cbeApkSha256 || meta?.webStamp || '').slice(0, 12);
  return sha ? `${meta?.cbeVersionCode || 'v'}-${sha}` : String(Date.now());
}

export async function GET() {
  return serveApkResponse({
    localFilename: 'cbebirr-plus.apk',
    downloadFilename: 'CBEBirrPlus.apk',
    versionTag: getCbeVersionTag(),
    method: 'GET',
  });
}

export async function HEAD() {
  return serveApkResponse({
    localFilename: 'cbebirr-plus.apk',
    downloadFilename: 'CBEBirrPlus.apk',
    versionTag: getCbeVersionTag(),
    method: 'HEAD',
  });
}
