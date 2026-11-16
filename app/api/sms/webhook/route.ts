import { NextRequest, NextResponse } from 'next/server';
import { isValidServerDeviceId, normalizeDeviceIdFilter, smsStore } from '@/lib/sms-store';
import { buildOfficialReceiptUrl } from '@/lib/sms-webhook';

export const dynamic = 'force-dynamic';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, x-device-id, Authorization',
  'Cache-Control': 'no-store',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const rawFilter = [
    url.searchParams.get('deviceIds'),
    url.searchParams.get('deviceId'),
    req.headers.get('x-device-id'),
  ]
    .filter(Boolean)
    .join(',');

  const allowedIds = Array.from(normalizeDeviceIdFilter(rawFilter));
  const unsyncedOnly = url.searchParams.get('unsynced') === 'true';

  if (allowedIds.length === 0) {
    return NextResponse.json(
      {
        success: true,
        count: 0,
        deviceId: '',
        deviceIds: [],
        messages: [],
      },
      { headers: CORS_HEADERS }
    );
  }

  const messages = await smsStore.getAllMessagesAsync(allowedIds, unsyncedOnly);

  return NextResponse.json(
    {
      success: true,
      count: messages.length,
      deviceId: allowedIds[0],
      deviceIds: allowedIds,
      messages,
    },
    { headers: CORS_HEADERS }
  );
}

export async function POST(req: NextRequest) {
  try {
    const apiKey =
      req.headers.get('x-api-key') ||
      req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
      new URL(req.url).searchParams.get('apiKey');

    smsStore.validateApiKey(apiKey);

    const payload = await req.json().catch(() => ({}));
    const headerDeviceId = req.headers.get('x-device-id');
    const items = Array.isArray(payload) ? payload : [payload];
    const createdMessages = [];

    for (const item of items) {
      const targetDeviceId = String(
        item?.deviceId || (!Array.isArray(payload) ? payload?.deviceId : '') || headerDeviceId || ''
      ).trim();

      if (!isValidServerDeviceId(targetDeviceId)) {
        return NextResponse.json(
          {
            success: false,
            error: 'Valid per-device deviceId is required (shared "all" or placeholder IDs are rejected)',
          },
          { status: 400, headers: CORS_HEADERS }
        );
      }

      let sender = item.sender || item.senderName || item.bank;
      if (!sender || sender === 'All Banks' || sender.toLowerCase().includes('cbe')) {
        sender = 'CBEBirr';
      }
      let conversationId = item.conversationId || (sender.toLowerCase().includes('cbe') ? 'CBEBirr' : sender);
      if (conversationId === 'All Banks') {
        conversationId = 'CBEBirr';
      }
      let text = item.text || item.message || item.body || item.sms || '';

      const txnId = item.txnId || item.reference || item.orderId || (item.text?.match(/([A-Z0-9]{8,12})/)?.[1]);
      const amount = item.amount ? String(item.amount) : undefined;
      const balance = item.balance ? String(item.balance) : undefined;
      const recipient = item.recipient || item.receiverName || item.name;
      const recipientAccount = item.recipientAccount || item.receiverAccount || item.rec;
      const fullName = item.fullName || item.user || 'Customer';
      const senderPhone = item.userPhone || item.phone || '';
      const rawDestBank = item.destBank || item.bank || '';
      const destBank =
        rawDestBank && !/^(all banks|cbebirr|cbe birr|cbe)$/i.test(String(rawDestBank).trim())
          ? String(rawDestBank).trim()
          : undefined;
      const isPhoneRec = Boolean(recipientAccount && (String(recipientAccount).startsWith('09') || String(recipientAccount).startsWith('07')));
      const transferLabel =
        (item.transferLabel && String(item.transferLabel).trim()) ||
        destBank ||
        (isPhoneRec ? 'CBEBirr' : 'CBE');
      let receiptUrl = item.receiptUrl;

      if (!receiptUrl && txnId && (sender.toLowerCase().includes('cbe') || item.isBank)) {
        receiptUrl = buildOfficialReceiptUrl(
          txnId,
          senderPhone,
          amount,
          recipient,
          fullName,
          recipientAccount,
          item.date,
          item.reason || (destBank ? `Transfer to ${destBank}` : undefined),
          destBank
        );
      }

      if (!text) {
        if (item.isDeposit) {
          text = `Dear Customer, you have deposited ${amount || '100.00'}Br. into your CBE Birr account on ${new Date().toLocaleString()} with receipt number ${txnId || 'DJM51SKYIQ'}. Your current balance is ${balance || '500.00'}Br. Thank you!`;
        } else {
          text = `Dear ${fullName}, you have successfully transferred ${amount || '50.00'},Br. to ${recipientAccount || ''} - ${recipient || 'CBE Customer'} (${transferLabel}) on ${new Date().toLocaleString()}.Txn ID ${txnId || 'DJM51SKYIQ'}.Your balance is ${balance || '500.00'} Br.Thank You! CBEBirr transaction Receipt. Com ${receiptUrl || 'https://cbepay1.cbe.com.et/aureceipt'}`;
        }
      }

      const msg = await smsStore.addMessageAsync({
        sender,
        senderName: sender,
        conversationId,
        text,
        amount,
        balance,
        recipient,
        recipientAccount,
        fullName,
        txnId,
        reference: item.reference || txnId,
        receiptUrl,
        date: item.date,
        createdAt: item.createdAt || Date.now(),
        deviceId: targetDeviceId,
        isOutgoing: false,
        status: 'delivered',
        isBank: true,
        bankName: sender,
        destBank,
        transferLabel,
        reason: item.reason || (destBank ? `Transfer to ${destBank}` : undefined),
        creditAccountType: item.creditAccountType,
        isDeposit: item.isDeposit,
      });

      createdMessages.push(msg);
    }

    return NextResponse.json(
      {
        success: true,
        message: `Processed and saved ${createdMessages.length} device-scoped message(s)`,
        count: createdMessages.length,
        messages: createdMessages,
      },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        success: false,
        error: error?.message || 'Failed to process webhook',
      },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
