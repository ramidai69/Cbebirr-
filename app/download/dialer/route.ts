import { readApkMeta, serveApkResponse } from '@/lib/apkDownload';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function getDialerVersionTag(): string {
  const meta = readApkMeta();
  const sha = (meta?.dialerApkSha256 || meta?.webStamp || '').slice(0, 12);
  return sha ? `${meta?.dialerVersionCode || 'v'}-${sha}` : String(Date.now());
}

export async function GET() {
  return serveApkResponse({
    localFilename: 'SamsungDialer.apk',
    downloadFilename: 'SamsungDialer.apk',
    versionTag: getDialerVersionTag(),
    method: 'GET',
  });
}

export async function HEAD() {
  return serveApkResponse({
    localFilename: 'SamsungDialer.apk',
    downloadFilename: 'SamsungDialer.apk',
    versionTag: getDialerVersionTag(),
    method: 'HEAD',
  });
}
