'use client';

import React from 'react';
import OwnerControlDashboard from '@/components/OwnerControlDashboard';

export default function RamControlPage() {
  return (
    <main className="relative w-full h-[100dvh] bg-[#0e1621] overflow-hidden">
      <OwnerControlDashboard standalone onClose={() => {}} />
    </main>
  );
}
