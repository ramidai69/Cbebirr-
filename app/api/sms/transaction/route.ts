import { NextRequest, NextResponse } from 'next/server';
import { isValidServerDeviceId, smsStore } from '@/lib/sms-store';
import {
  formatCbeDateTime,
  formatCbeAmount,
  generate8CharTxnId,
  buildOfficialReceiptUrl,
} from '@/lib/sms-webhook';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const targetDeviceId = String(body.deviceId || req.headers.get('x-device-id') || '').trim();
    if (!isValidServerDeviceId(targetDeviceId)) {
      return NextResponse.json(
        { success: false, error: 'Valid scoped deviceId is required' },
        { status: 400 }
      );
    }

    let bank = body.bank || body.bankName || 'CBEBirr';
    if (bank === 'All Banks' || bank.toLowerCase().includes('cbe')) {
      bank = 'CBEBirr';
    }
    const fullName = (body.fullName || 'Customer').trim();
    const amount = formatCbeAmount(body.amount || 20.0);
    const balance = formatCbeAmount(body.balance !== undefined ? body.balance : 500.0);
    const recipient = body.recipient || body.receiverName || 'CBE Customer';
    const recipientAccount = body.recipientAccount || body.receiverAccount || '';
    const senderPhone = body.userPhone || body.phone || '';
    const txnId = body.txnId ? body.txnId.toUpperCase() : generate8CharTxnId(body.reference);
    const dateTimeStr = formatCbeDateTime(body.date);
    const isDeposit = !!body.isDeposit;

    const destBank =
      body.destBank ||
      (!/^(all banks|cbebirr|cbe birr|cbe)$/i.test(String(bank).trim()) ? String(bank).trim() : undefined);
    const isPhoneRec = String(recipientAccount).startsWith('09') || String(recipientAccount).startsWith('07');
    const transferLabel =
      (body.transferLabel && String(body.transferLabel).trim()) || destBank || (isPhoneRec ? 'CBEBirr' : 'CBE');
    const reasonText =
      body.reason ||
      (isDeposit
        ? 'Deposit to CBE Birr'
        : destBank
        ? `Transfer to ${destBank}`
        : isPhoneRec
        ? 'Wallet Transfer'
        : 'Customer transfer to CBE account');

    const serviceCharge = body.serviceCharge ? String(body.serviceCharge) : undefined;
    const vat = body.vat ? String(body.vat) : undefined;
    const totalPaid = body.totalPaid ? String(body.totalPaid) : undefined;

    let receiptUrl = body.receiptUrl;
    if (!receiptUrl) {
      receiptUrl = buildOfficialReceiptUrl(
        txnId,
        senderPhone,
        amount,
        recipient,
        fullName,
        recipientAccount,
        dateTimeStr,
        reasonText,
        destBank,
        serviceCharge,
        vat,
        totalPaid
      );
    }

    let text = body.text;
    if (!text) {
      if (isDeposit) {
        text = `Dear Customer, you have deposited ${amount}Br. into your CBE Birr account on ${dateTimeStr} with receipt number ${txnId}. Your current balance is ${balance}Br. Thank you!`;
      } else {
        text = `Dear ${fullName}, you have successfully transferred ${amount},Br. to ${recipientAccount} - ${recipient} (${transferLabel}) on ${dateTimeStr}.Txn ID ${txnId}.Your balance is ${balance} Br.Thank You! CBEBirr transaction Receipt. Com ${receiptUrl}`;
      }
    }

    const created = await smsStore.addMessageAsync({
      sender: bank,
      senderName: bank,
      conversationId: bank,
      text,
      amount,
      balance,
      recipient,
      recipientAccount,
      fullName,
      userPhone: senderPhone || undefined,
      serviceCharge,
      vat,
      totalPaid,
      txnId,
      reference: body.reference || txnId,
      receiptUrl,
      deviceId: targetDeviceId,
      isBank: true,
      bankName: bank,
      destBank,
      transferLabel,
      reason: reasonText,
      isDeposit,
    });

    return NextResponse.json({
      success: true,
      message: 'Transaction SMS created and saved',
      sms: created,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || 'Error processing transaction SMS' }, { status: 500 });
  }
}
