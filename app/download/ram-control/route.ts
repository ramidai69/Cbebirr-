import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function getRamControlVersionTag(): string {
  try {
    const metaPath = path.join(process.cwd(), 'public', 'apk-version.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
        ramControlApkSha256?: string;
        ramControlVersionCode?: number;
        webStamp?: string;
      };
      const sha = (meta.ramControlApkSha256 || meta.webStamp || '').slice(0, 12);
      if (sha) {
        return `${meta.ramControlVersionCode || 'v'}-${sha}`;
      }
    }
  } catch {}
  return String(Date.now());
}

export async function GET() {
  const apkPath = path.join(process.cwd(), 'public', 'RamControl.apk');
  if (fs.existsSync(apkPath)) {
    const stat = fs.statSync(apkPath);
    const webStream = Readable.toWeb(fs.createReadStream(apkPath)) as ReadableStream<Uint8Array>;

    return new NextResponse(webStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': 'attachment; filename="RamControl.apk"',
        'Content-Length': String(stat.size),
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Apk-Version': getRamControlVersionTag(),
      },
    });
  }

  try {
    const upstream = await fetch('https://cbebirr-lovat.vercel.app/RamControl.apk', {
      cache: 'no-store',
    });
    if (upstream.ok && upstream.body) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': 'attachment; filename="RamControl.apk"',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Apk-Version': getRamControlVersionTag(),
      };
      const len = upstream.headers.get('content-length');
      if (len) headers['Content-Length'] = len;
      return new NextResponse(upstream.body, { status: 200, headers });
    }
  } catch {}

  return NextResponse.json({ error: 'RamControl.apk not found' }, { status: 404 });
}
