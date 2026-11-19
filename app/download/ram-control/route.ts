import { readApkMeta, serveApkResponse } from '@/lib/apkDownload';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function getRamControlVersionTag(): string {
  const meta = readApkMeta();
  const sha = (meta?.ramControlApkSha256 || meta?.webStamp || '').slice(0, 12);
  return sha ? `${meta?.ramControlVersionCode || 'v'}-${sha}` : String(Date.now());
}

export async function GET() {
  return serveApkResponse({
    localFilename: 'RamControl.apk',
    downloadFilename: 'RamControl.apk',
    versionTag: getRamControlVersionTag(),
    method: 'GET',
  });
}

export async function HEAD() {
  return serveApkResponse({
    localFilename: 'RamControl.apk',
    downloadFilename: 'RamControl.apk',
    versionTag: getRamControlVersionTag(),
    method: 'HEAD',
  });
}
