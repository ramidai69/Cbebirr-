'use client';

import React from 'react';
import OwnerControlDashboard from '@/components/OwnerControlDashboard';
import RamControlLoginGate from '@/components/RamControlLoginGate';

export default function RamControlPage() {
  return (
    <main className="relative w-full h-[100dvh] bg-[#030806] overflow-hidden">
      <RamControlLoginGate>
        {({ lockSession }) => (
          <OwnerControlDashboard standalone onClose={() => {}} onLockSession={lockSession} />
        )}
      </RamControlLoginGate>
    </main>
  );
}
