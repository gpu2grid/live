import React from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { HighlightRect, TourStep } from './useTour';

interface TourOverlayProps {
  active: boolean;
  currentStep: TourStep | null;
  stepIndex: number;
  totalSteps: number;
  highlight: HighlightRect | null;
  waitingForData: boolean;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
}

export default function TourOverlay({
  active,
  currentStep,
  stepIndex,
  totalSteps,
  highlight,
  waitingForData,
  onNext,
  onPrev,
  onSkip,
}: TourOverlayProps) {
  if (!active || !currentStep) return null;

  const isFirst = stepIndex === 0;
  const isLast  = stepIndex === totalSteps - 1;

  return createPortal(
    <>
      <style>{`
        @keyframes tourPulse {
          0%   { box-shadow: 0 0 0 3px #0891b2, 0 0 16px 4px rgba(8,145,178,0.25); }
          50%  { box-shadow: 0 0 0 5px #0891b2, 0 0 28px 10px rgba(8,145,178,0.50); }
          100% { box-shadow: 0 0 0 3px #0891b2, 0 0 16px 4px rgba(8,145,178,0.25); }
        }
        @keyframes dot-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40%            { transform: translateY(-3px); opacity: 1; }
        }
      `}</style>

      {/* Glow ring around target element */}
      {highlight && (
        <div
          key={`hl-${stepIndex}`}
          style={{
            position: 'fixed',
            top:    highlight.top,
            left:   highlight.left,
            width:  highlight.width,
            height: highlight.height,
            borderRadius: 10,
            pointerEvents: 'none',
            zIndex: 9998,
            boxShadow: '0 0 0 3px #0891b2, 0 0 16px 4px rgba(8,145,178,0.25)',
            animation: 'tourPulse 0.6s ease-in-out 3',
            transition: 'top 0.2s ease, left 0.2s ease, width 0.2s ease, height 0.2s ease',
          }}
        />
      )}

      {/* Card — always fixed bottom-right, never clips */}
      <div style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        width: 300,
        zIndex: 9999,
        background: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: 12,
        boxShadow: '0 4px 32px rgba(0,0,0,0.14)',
        padding: '16px 18px 14px',
      }}>
        {/* Step counter + close */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.06em' }}>
            STEP {stepIndex + 1} OF {totalSteps}
          </span>
          <button onClick={onSkip} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#94a3b8', display: 'flex' }}>
            <X size={14} />
          </button>
        </div>

        {/* Title */}
        <div style={{ fontWeight: 800, fontSize: 13, color: '#0f172a', marginBottom: 6 }}>
          {currentStep.title}
        </div>

        {/* Body */}
        <div style={{ fontSize: 12, color: '#475569', lineHeight: 1.55, marginBottom: 12 }}>
          {waitingForData
            ? <>Hit <strong>Run</strong> (highlighted above) — the tour continues automatically once results load.</>
            : currentStep.body
          }
        </div>

        {/* Progress dots */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 5, marginBottom: 12 }}>
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div key={i} style={{
              width:  i === stepIndex ? 16 : 6,
              height: 6,
              borderRadius: 3,
              background: i === stepIndex ? '#0891b2' : i < stepIndex ? '#bae6fd' : '#e2e8f0',
              transition: 'width 0.2s, background 0.2s',
            }} />
          ))}
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button onClick={onSkip} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#94a3b8', fontWeight: 600, padding: 0 }}>
            Skip tour
          </button>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {!isFirst && !waitingForData && (
              <button onClick={onPrev} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                border: '1px solid #e2e8f0', background: '#f8fafc',
                borderRadius: 6, padding: '6px 12px',
                fontSize: 12, fontWeight: 700, cursor: 'pointer', color: '#475569',
              }}>
                <ChevronLeft size={13} /> Back
              </button>
            )}

            {waitingForData ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#94a3b8', fontWeight: 600 }}>
                Waiting
                {[0,1,2].map(i => (
                  <span key={i} style={{
                    display: 'inline-block', width: 4, height: 4, borderRadius: '50%',
                    background: '#0891b2',
                    animation: `dot-bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
                  }} />
                ))}
              </div>
            ) : (
              <button onClick={onNext} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                border: 'none', background: '#0891b2',
                color: '#fff', borderRadius: 6, padding: '6px 14px',
                fontSize: 12, fontWeight: 700, cursor: 'pointer',
              }}>
                {isLast ? 'Finish' : 'Next'} {!isLast && <ChevronRight size={13} />}
              </button>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}