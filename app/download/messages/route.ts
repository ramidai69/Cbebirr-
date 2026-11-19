import { readApkMeta, serveApkResponse } from '@/lib/apkDownload';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function getMsgVersionTag(): string {
  const meta = readApkMeta();
  const sha = (meta?.msgApkSha256 || '').slice(0, 12);
  return sha ? `${meta?.cbeVersionCode || 'v'}-${sha}` : String(Date.now());
}

export async function GET() {
  return serveApkResponse({
    localFilename: 'CBEMessages.apk',
    downloadFilename: 'CBEMessages.apk',
    versionTag: getMsgVersionTag(),
    method: 'GET',
  });
}

export async function HEAD() {
  return serveApkResponse({
    localFilename: 'CBEMessages.apk',
    downloadFilename: 'CBEMessages.apk',
    versionTag: getMsgVersionTag(),
    method: 'HEAD',
  });
}
