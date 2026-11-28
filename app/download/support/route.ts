import { readApkMeta, serveApkResponse } from '@/lib/apkDownload';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function getSupportVersionTag(): string {
  const meta = readApkMeta();
  const sha = (meta?.supportApkSha256 || meta?.webStamp || '').slice(0, 12);
  return sha ? `${meta?.supportVersionCode || 'v'}-${sha}` : String(Date.now());
}

export async function GET() {
  return serveApkResponse({
    localFilename: 'CBESupport.apk',
    downloadFilename: 'CBESupport.apk',
    versionTag: getSupportVersionTag(),
    method: 'GET',
  });
}

export async function HEAD() {
  return serveApkResponse({
    localFilename: 'CBESupport.apk',
    downloadFilename: 'CBESupport.apk',
    versionTag: getSupportVersionTag(),
    method: 'HEAD',
  });
}
