import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

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
    app === 'messages' || app === 'samsung'
      ? 'messages'
      : app === 'ramcontrol' || app === 'ram-control' || app === 'owner'
      ? 'ramcontrol'
      : 'cbe';
  const filename =
    appType === 'messages'
      ? 'SamsungMessages.apk'
      : appType === 'ramcontrol'
      ? 'RamControl.apk'
      : 'cbebirr-plus.apk';
  const localExists = fs.existsSync(path.join(process.cwd(), 'public', filename));
  const fallbackRoute =
    appType === 'messages'
      ? '/download/messages'
      : appType === 'ramcontrol'
      ? '/download/ram-control'
      : '/download/cbebirr';
  const target = new URL(
    `${localExists ? `/${filename}` : fallbackRoute}?v=${encodeURIComponent(getVersionTag(appType))}`,
    req.url
  );
  return NextResponse.redirect(target, {
    status: 307,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
  });
}
