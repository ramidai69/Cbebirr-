'use client';

import React from 'react';

interface ProportionalScreenStageProps {
  children: React.ReactNode;
  ratioW?: number;
  ratioH?: number;
  align?: 'top' | 'center';
  bodyColor?: string;
  topBandColor?: string;
  topBandEndPct?: number;
  leftTopBandColor?: string;
  leftTopBandEndPct?: number;
  rightTopBandColor?: string;
  rightTopBandEndPct?: number;
  bottomBandColor?: string;
  bottomBandStartPct?: number;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  className?: string;
}

export default function ProportionalScreenStage({
  children,
  ratioW = 720,
  ratioH = 1527,
  align = 'top',
  bodyColor = '#eeeeee',
  topBandColor,
  topBandEndPct,
  leftTopBandColor,
  leftTopBandEndPct,
  rightTopBandColor,
  rightTopBandEndPct,
  bottomBandColor,
  bottomBandStartPct,
  onClick,
  className = '',
}: ProportionalScreenStageProps) {
  const stageW = `min(100%, calc(var(--cbe-frame-h, 100vh) * ${ratioW} / ${ratioH}))`;
  const stageH = `min(100%, calc(var(--cbe-frame-w, 100vw) * ${ratioH} / ${ratioW}))`;

  return (
    <div
      onClick={onClick}
      style={{
        backgroundColor: bodyColor,
        ['--cbe-stage-w' as string]: stageW,
        ['--cbe-stage-h' as string]: stageH,
      }}
      className={`relative w-full h-full flex ${
        align === 'center' ? 'items-center' : 'items-start'
      } justify-center overflow-hidden ${className}`}
    >
      {/* Seamless Edge-Matched Perimeter Bands (zero horizontal/vertical distortion of core screen) */}
      {topBandColor && typeof topBandEndPct === 'number' && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: `calc(var(--cbe-stage-h) * ${topBandEndPct / 100})`,
            backgroundColor: topBandColor,
          }}
          className="pointer-events-none select-none z-0"
        />
      )}

      {leftTopBandColor && typeof leftTopBandEndPct === 'number' && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '50%',
            height: `calc(var(--cbe-stage-h) * ${leftTopBandEndPct / 100})`,
            backgroundColor: leftTopBandColor,
          }}
          className="pointer-events-none select-none z-0"
        />
      )}

      {rightTopBandColor && typeof rightTopBandEndPct === 'number' && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: '50%',
            height: `calc(var(--cbe-stage-h) * ${rightTopBandEndPct / 100})`,
            backgroundColor: rightTopBandColor,
          }}
          className="pointer-events-none select-none z-0"
        />
      )}

      {bottomBandColor && typeof bottomBandStartPct === 'number' && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: `calc(var(--cbe-stage-h) * ${bottomBandStartPct / 100})`,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: bottomBandColor,
          }}
          className="pointer-events-none select-none z-0"
        />
      )}

      {/* Aspect-Locked Core UI & Interactive Overlays */}
      <div
        style={{
          position: 'relative',
          width: stageW,
          height: stageH,
          flexShrink: 0,
          containerType: 'inline-size',
        }}
        className="z-10"
      >
        {children}
      </div>
    </div>
  );
}
