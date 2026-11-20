'use client';

import React from 'react';

interface ProportionalScreenStageProps {
  children: React.ReactNode;
  ratioW?: number;
  ratioH?: number;
  align?: 'top' | 'center';
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  className?: string;
}

export default function ProportionalScreenStage({
  children,
  align = 'center',
  onClick,
  className = '',
}: ProportionalScreenStageProps) {
  return (
    <div
      onClick={onClick}
      style={{
        ['--cbe-stage-w' as string]: '100%',
        ['--cbe-stage-h' as string]: '100%',
      }}
      className={`relative w-full h-full flex ${
        align === 'center' ? 'items-center' : 'items-start'
      } justify-center overflow-hidden ${className}`}
    >
      {/* Full-Screen 100% Edge-to-Edge PNG Stage & Overlays (zero black/white sidebars) */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          flexShrink: 0,
          containerType: 'inline-size',
        }}
        className="z-10 overflow-hidden"
      >
        {children}
      </div>
    </div>
  );
}
