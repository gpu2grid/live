import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
export default function TourOverlay({ active, currentStep, stepIndex, totalSteps, highlight, waitingForData, onNext, onPrev, onSkip, }) {
    if (!active || !currentStep)
        return null;
    const isFirst = stepIndex === 0;
    const isLast = stepIndex === totalSteps - 1;
    return createPortal(_jsxs(_Fragment, { children: [_jsx("style", { children: `
        @keyframes tourPulse {
          0%   { box-shadow: 0 0 0 3px #0891b2, 0 0 16px 4px rgba(8,145,178,0.25); }
          50%  { box-shadow: 0 0 0 5px #0891b2, 0 0 28px 10px rgba(8,145,178,0.50); }
          100% { box-shadow: 0 0 0 3px #0891b2, 0 0 16px 4px rgba(8,145,178,0.25); }
        }
        @keyframes dot-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40%            { transform: translateY(-3px); opacity: 1; }
        }
      ` }), highlight && (_jsx("div", { style: {
                    position: 'fixed',
                    top: highlight.top,
                    left: highlight.left,
                    width: highlight.width,
                    height: highlight.height,
                    borderRadius: 10,
                    pointerEvents: 'none',
                    zIndex: 9998,
                    boxShadow: '0 0 0 3px #0891b2, 0 0 16px 4px rgba(8,145,178,0.25)',
                    animation: 'tourPulse 0.6s ease-in-out 3',
                    transition: 'top 0.2s ease, left 0.2s ease, width 0.2s ease, height 0.2s ease',
                } }, `hl-${stepIndex}`)), _jsxs("div", { style: {
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
                }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }, children: [_jsxs("span", { style: { fontSize: 10, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.06em' }, children: ["STEP ", stepIndex + 1, " OF ", totalSteps] }), _jsx("button", { onClick: onSkip, style: { background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#94a3b8', display: 'flex' }, children: _jsx(X, { size: 14 }) })] }), _jsx("div", { style: { fontWeight: 800, fontSize: 13, color: '#0f172a', marginBottom: 6 }, children: currentStep.title }), _jsx("div", { style: { fontSize: 12, color: '#475569', lineHeight: 1.55, marginBottom: 12 }, children: waitingForData
                            ? _jsxs(_Fragment, { children: ["Hit ", _jsx("strong", { children: "Run" }), " (highlighted above) \u2014 the tour continues automatically once results load."] })
                            : currentStep.body }), _jsx("div", { style: { display: 'flex', justifyContent: 'center', gap: 5, marginBottom: 12 }, children: Array.from({ length: totalSteps }).map((_, i) => (_jsx("div", { style: {
                                width: i === stepIndex ? 16 : 6,
                                height: 6,
                                borderRadius: 3,
                                background: i === stepIndex ? '#0891b2' : i < stepIndex ? '#bae6fd' : '#e2e8f0',
                                transition: 'width 0.2s, background 0.2s',
                            } }, i))) }), _jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("button", { onClick: onSkip, style: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#94a3b8', fontWeight: 600, padding: 0 }, children: "Skip tour" }), _jsxs("div", { style: { display: 'flex', gap: 8, alignItems: 'center' }, children: [!isFirst && !waitingForData && (_jsxs("button", { onClick: onPrev, style: {
                                            display: 'flex', alignItems: 'center', gap: 4,
                                            border: '1px solid #e2e8f0', background: '#f8fafc',
                                            borderRadius: 6, padding: '6px 12px',
                                            fontSize: 12, fontWeight: 700, cursor: 'pointer', color: '#475569',
                                        }, children: [_jsx(ChevronLeft, { size: 13 }), " Back"] })), waitingForData ? (_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#94a3b8', fontWeight: 600 }, children: ["Waiting", [0, 1, 2].map(i => (_jsx("span", { style: {
                                                    display: 'inline-block', width: 4, height: 4, borderRadius: '50%',
                                                    background: '#0891b2',
                                                    animation: `dot-bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
                                                } }, i)))] })) : (_jsxs("button", { onClick: onNext, style: {
                                            display: 'flex', alignItems: 'center', gap: 4,
                                            border: 'none', background: '#0891b2',
                                            color: '#fff', borderRadius: 6, padding: '6px 14px',
                                            fontSize: 12, fontWeight: 700, cursor: 'pointer',
                                        }, children: [isLast ? 'Finish' : 'Next', " ", !isLast && _jsx(ChevronRight, { size: 13 })] }))] })] })] })] }), document.body);
}
