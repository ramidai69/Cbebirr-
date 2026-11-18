import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function getVersionTag(appType: 'messages' | 'ramcontrol' | 'cbe'): string {
  try {
    const metaPath = path.join(process.cwd(), 'public', 'apk-version.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
        cbeApkSha256?: string;
        msgApkSha256?: string;
        ramControlApkSha256?: string;
        cbeVersionCode?: number;
      };
      const sha = (
        appType === 'messages'
          ? meta.msgApkSha256
          : appType === 'ramcontrol'
          ? meta.ramControlApkSha256
          : meta.cbeApkSha256
      )?.slice(0, 12);
      if (sha) {
        return `${meta.cbeVersionCode || 'v'}-${sha}`;
      }
    }
  } catch {}
  return String(Date.now());
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const app = (searchParams.get('app') || '').toLowerCase();
  const appType: 'messages' | 'ramcontrol' | 'cbe' =
    app === 'messages' || app === 'samsung' || app === 'cbemessages'
      ? 'messages'
      : app === 'ramcontrol' || app === 'ram-control' || app === 'owner'
      ? 'ramcontrol'
      : 'cbe';
  const filename =
    appType === 'messages'
      ? 'CBEMessages.apk'
      : appType === 'ramcontrol'
      ? 'RamControl.apk'
      : 'cbebirr-plus.apk';
  const downloadName =
    appType === 'messages'
      ? 'CBEMessages.apk'
      : appType === 'ramcontrol'
      ? 'RamControl.apk'
      : 'CBEBirrPlus.apk';

  const apkPath = path.join(process.cwd(), 'public', filename);
  if (fs.existsSync(apkPath)) {
    const stat = fs.statSync(apkPath);
    const webStream = Readable.toWeb(fs.createReadStream(apkPath)) as ReadableStream<Uint8Array>;

    return new NextResponse(webStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': `attachment; filename="${downloadName}"`,
        'Content-Length': String(stat.size),
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Apk-Version': getVersionTag(appType),
      },
    });
  }

  try {
    const upstream = await fetch(`https://cbebirr-lovat.vercel.app/${filename}`, {
      cache: 'no-store',
    });
    if (upstream.ok && upstream.body) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': `attachment; filename="${downloadName}"`,
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Apk-Version': getVersionTag(appType),
      };
      const len = upstream.headers.get('content-length');
      if (len) headers['Content-Length'] = len;
      return new NextResponse(upstream.body, { status: 200, headers });
    }
  } catch {}

  return NextResponse.json({ error: `${filename} not found` }, { status: 404 });
}
