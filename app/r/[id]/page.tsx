import { Suspense } from 'react';
import OfficialReceiptView, { OfficialReceiptData } from '@/components/OfficialReceiptView';
import { getReceiptAsync, ORIGINAL_QR_TID } from '@/lib/receipt-store';

export const dynamic = 'force-dynamic';

type SearchParamsRecord = Record<string, string | string[] | undefined>;

function pickParam(sp: SearchParamsRecord, ...keys: string[]): string {
  for (const key of keys) {
    const val = sp[key];
    if (Array.isArray(val) && val[0]) return val[0];
    if (typeof val === 'string' && val) return val;
  }
  return '';
}

export default async function ShortReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParamsRecord>;
}) {
  const resolvedParams = await params;
  const sp = await searchParams;
  const rawRef = decodeURIComponent(resolvedParams.id || '') || pickParam(sp, 'TID', 'ref', 'tid') || ORIGINAL_QR_TID;
  const stored = await getReceiptAsync(rawRef);

  const hasRichStoredAmt = Boolean(stored?.amt && stored.amt !== '0.00');
  const paramAmt = pickParam(sp, 'amt');

  const initialData: OfficialReceiptData = {
    ref: stored?.ref || rawRef,
    orderId: pickParam(sp, 'orderId') || stored?.orderId || stored?.ref || rawRef,
    amt: paramAmt || (hasRichStoredAmt ? stored.amt : ''),
    rec: pickParam(sp, 'rec', 'receiverAccount') || stored?.rec || '',
    name: pickParam(sp, 'name', 'receiverName') || stored?.name || '',
    user: pickParam(sp, 'user', 'fullName') || (hasRichStoredAmt ? stored?.user : '') || '',
    acc: pickParam(sp, 'acc', 'PH', 'userAcc') || stored?.acc || '',
    date: pickParam(sp, 'date') || stored?.date || '',
    reason: pickParam(sp, 'reason') || (hasRichStoredAmt ? stored?.reason : '') || '',
    bank: pickParam(sp, 'bank', 'destBank') || stored?.bank || '',
    serviceCharge: pickParam(sp, 'fee', 'serviceCharge') || stored?.serviceCharge || '',
    vat: pickParam(sp, 'vat') || stored?.vat || '',
    totalPaid: pickParam(sp, 'totalPaid') || stored?.totalPaidAmount || '',
  };

  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#f0f2f5] flex items-center justify-center p-2 sm:p-4 select-none">
          <div className="w-full max-w-[440px] sm:max-w-[480px] bg-white shadow-2xl rounded-lg border border-slate-300/80 overflow-hidden aspect-[665/912] animate-pulse" />
        </div>
      }
    >
      <OfficialReceiptView initialData={initialData} />
    </Suspense>
  );
}
