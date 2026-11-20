'use client';

import React from 'react';

interface CBEAuthenticSpinnerProps {
  size?: number; // overall width/height in px
  cssSize?: string; // optional container-relative size (e.g. '100%', '10cqw')
  color?: string; // dot color (brand purple #8b278e)
  className?: string;
  speed?: number; // animation cycle duration in seconds
  dotCount?: number; // authentic 8 dots in CBEBirr
}

export default function CBEAuthenticSpinner({
  size = 38,
  cssSize,
  color = '#8b278e',
  className = '',
  speed = 0.85,
  dotCount = 8,
}: CBEAuthenticSpinnerProps) {
  const dim = cssSize || `${size}px`;

  return (
    <div
      className={`relative inline-flex items-center justify-center select-none pointer-events-none ${className}`}
      style={{ width: dim, height: dim }}
      aria-label="Loading..."
      role="status"
    >
      {Array.from({ length: dotCount }).map((_, index) => {
        const angle = index * (360 / dotCount);
        // Staggered negative delay so dots light up and turn off sequentially clockwise
        const delay = -((dotCount - index) * (speed / dotCount));

        return (
          <div
            key={index}
            className="absolute origin-center flex items-center justify-center pointer-events-none select-none"
            style={{
              width: '19%',
              height: '19%',
              top: '50%',
              left: '50%',
              transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-189.5%)`,
            }}
          >
            <span
              className="block w-full h-full rounded-full"
              style={{
                backgroundColor: color,
                animation: `cbeDotChaser ${speed}s linear infinite`,
                animationDelay: `${delay}s`,
                willChange: 'opacity, transform',
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

