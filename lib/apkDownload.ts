import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

const GITHUB_RAW_PUBLIC_BASE = 'https://raw.githubusercontent.com/ramidai69/Cbebirr-/main/public';

export type ApkMeta = {
  cbeApkSha256?: string;
  cbeApkSize?: number;
  msgApkSha256?: string;
  msgApkSize?: number;
  ramControlApkSha256?: string;
  ramControlApkSize?: number;
  dialerApkSha256?: string;
  dialerApkSize?: number;
  supportApkSha256?: string;
  supportApkSize?: number;
  cbeVersionCode?: number;
  ramControlVersionCode?: number;
  dialerVersionCode?: number;
  dialerVersionName?: string;
  supportVersionCode?: number;
  supportVersionName?: string;
  webStamp?: string;
};

export function readApkMeta(): ApkMeta | null {
  try {
    const metaPath = path.join(process.cwd(), 'public', 'apk-version.json');
    if (fs.existsSync(metaPath)) {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ApkMeta;
    }
  } catch {}
  return null;
}

export async function serveApkResponse(options: {
  localFilename: string;
  downloadFilename: string;
  versionTag: string;
  method?: 'GET' | 'HEAD';
}): Promise<NextResponse> {
  const { localFilename, downloadFilename, versionTag, method = 'GET' } = options;
  const apkPath = path.join(process.cwd(), 'public', localFilename);

  if (fs.existsSync(apkPath)) {
    const stat = fs.statSync(apkPath);
    const headers = {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': `attachment; filename="${downloadFilename}"`,
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'X-Apk-Version': versionTag,
      'X-Apk-Source': 'local',
    };

    if (method === 'HEAD') {
      return new NextResponse(null, { status: 200, headers });
    }

    const webStream = Readable.toWeb(fs.createReadStream(apkPath)) as ReadableStream<Uint8Array>;
    return new NextResponse(webStream, { status: 200, headers });
  }

  // Fallback: stream the binary directly from GitHub when large APKs are omitted during repo pull
  const remoteUrl = `${GITHUB_RAW_PUBLIC_BASE}/${encodeURIComponent(localFilename)}`;
  try {
    const upstream = await fetch(remoteUrl, {
      method,
      cache: 'no-store',
      redirect: 'follow',
    });

    if (!upstream.ok || (method === 'GET' && !upstream.body)) {
      return new NextResponse(`${localFilename} unavailable (upstream ${upstream.status})`, {
        status: 502,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': `attachment; filename="${downloadFilename}"`,
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'X-Apk-Version': versionTag,
      'X-Apk-Source': 'github-raw',
    };

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) {
      headers['Content-Length'] = contentLength;
    }

    if (method === 'HEAD') {
      return new NextResponse(null, { status: 200, headers });
    }

    return new NextResponse(upstream.body, { status: 200, headers });
  } catch (err) {
    console.error(`Failed to stream ${localFilename} from GitHub:`, err);
    return new NextResponse(`${localFilename} download failed`, {
      status: 502,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
}
