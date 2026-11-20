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
  ratioW = 720,
  ratioH = 1527,
  align = 'center',
  onClick,
  className = '',
}: ProportionalScreenStageProps) {
  const stageW = `min(100%, calc(var(--cbe-frame-h, 100vh) * ${ratioW} / ${ratioH}))`;
  const stageH = `min(100%, calc(var(--cbe-frame-w, 100vw) * ${ratioH} / ${ratioW}))`;

  return (
    <div
      onClick={onClick}
      style={{
        ['--cbe-stage-w' as string]: stageW,
        ['--cbe-stage-h' as string]: stageH,
      }}
      className={`relative w-full h-full flex ${
        align === 'center' ? 'items-center' : 'items-start'
      } justify-center overflow-hidden ${className}`}
    >
      {/* Pure 4-Side Proportional PNG Stage & Overlays (zero added bands or extra designs) */}
      <div
        style={{
          position: 'relative',
          width: stageW,
          height: stageH,
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
