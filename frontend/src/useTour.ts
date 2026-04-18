import { useState, useEffect, useCallback, useRef } from 'react';

export type Placement = 'top' | 'bottom' | 'left' | 'right';

export interface TourStep {
  id: string;
  title: string;
  body: string;
  targetSelector: string;
  requiresData?: boolean;
  noHighlight?: boolean;
}

export interface HighlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PADDING = 7;

const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to GPU-to-Grid',
    body: 'This page simulates how GPU data center affects a distribution feeder usinh IEEE 13 bus feeder.',
    targetSelector: '#llm-header',
    noHighlight: true,
  },
  {
    id: 'substation-voltage',
    title: 'Substation voltage',
    body: 'Sets the source voltage at the top of the feeder.',
    targetSelector: '#substation-voltage',
  },
  {
    id: 'bus-selector',
    title: 'Data center bus',
    body: 'Choose which node the GPU cluster connects to. ',
    targetSelector: '#bus-selector',
  },
  {
    id: 'cluster-size',
    title: 'Cluster size',
    body: 'Each "node" is one GPU server drawing ~400W.',
    targetSelector: '#cluster-size',
  },
  {
    id: 'gpu-delay',
    title: 'GPU inter-node delay',
    body: '',
    targetSelector: '#gpu-delay',
  },
  {
    id: 'run-button',
    title: 'Run the simulation',
    body: 'Press Run to send a 300-second GPU power trace and see effects',
    targetSelector: '#run-button',
  },
  {
    id: 'timeline-scrubber',
    title: 'Timeline playback',
    body: 'Drag the timeline or press Play to animate the grid through time. ',
    targetSelector: '#timeline-scrubber',
    requiresData: true,
  },
  {
    id: 'violation-chart',
    title: 'Violation frequency chart',
    body: 'Each bar shows how often a bus was outside the safe 0.95–1.05 p.u. band. ',
    targetSelector: '#violation-chart',
    requiresData: true,
  },
  {
    id: 'bus-grid',
    title: '13-bus voltage graphs',
    body: 'Each grapg representrs a bus in the feeder. ',
    targetSelector: '#bus-grid',
    requiresData: true,
  },
];

export const TOUR_STORAGE_KEY = 'llm-grid-tour-seen';

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

function getHighlight(selector: string): HighlightRect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    top:    rect.top    - PADDING,
    left:   rect.left   - PADDING,
    width:  rect.width  + PADDING * 2,
    height: rect.height + PADDING * 2,
  };
}

interface UseTourOptions {
  hasData: boolean;
}

export function useTour({ hasData }: UseTourOptions) {
  const [active, setActive]                 = useState(false);
  const [stepIndex, setStepIndex]           = useState(0);
  const [highlight, setHighlight]           = useState<HighlightRect | null>(null);
  const [waitingForData, setWaitingForData] = useState(false);

  const hasDataRef        = useRef(hasData);
  const stepIndexRef      = useRef(stepIndex);
  const waitingRef        = useRef(waitingForData);
  const visibleStepsRef   = useRef<TourStep[]>([]);

  useEffect(() => { hasDataRef.current   = hasData;        }, [hasData]);
  useEffect(() => { stepIndexRef.current = stepIndex;      }, [stepIndex]);
  useEffect(() => { waitingRef.current   = waitingForData; }, [waitingForData]);

  const visibleSteps = TOUR_STEPS.filter(s => !s.requiresData || hasData);
  visibleStepsRef.current = visibleSteps;

  const currentStep = active ? visibleSteps[stepIndex] ?? null : null;
  const totalSteps  = visibleSteps.length;

  const recalculate = useCallback((step: TourStep | null, overrideSelector?: string) => {
    if (!step || (step.noHighlight && !overrideSelector)) {
      setHighlight(null);
      return;
    }
    const selector = overrideSelector ?? step.targetSelector;
    const h = getHighlight(selector);
    if (!h) {
      // Element not ready yet — retry once
      setTimeout(() => {
        const h2 = getHighlight(selector);
        if (h2) setHighlight(h2);
      }, 200);
      return;
    }
    setHighlight(h);
  }, []);

  // Recalculate whenever step changes
  useEffect(() => {
    if (!active) return;
    const override = waitingForData ? '#run-button' : undefined;
    // Scroll highlighted element into view so glow is visible
    if (!waitingForData && currentStep && !currentStep.noHighlight) {
      const el = document.querySelector(currentStep.targetSelector);
      el?.scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'nearest' });
    }
    const t = setTimeout(() => recalculate(currentStep, override), 80);
    return () => clearTimeout(t);
  }, [active, stepIndex, currentStep, waitingForData, recalculate]);

  // Resize
  useEffect(() => {
    if (!active) return;
    const onResize = () => {
      const steps   = visibleStepsRef.current;
      const step    = steps[stepIndexRef.current] ?? null;
      const override = waitingRef.current ? '#run-button' : undefined;
      recalculate(step, override);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [active, recalculate]);

  // Auto-advance when simulation data arrives
  useEffect(() => {
    if (hasData && waitingForData && active) {
      setWaitingForData(false);
      const allVisible = TOUR_STEPS.filter(s => !s.requiresData || true);
      const firstData  = TOUR_STEPS.findIndex(s => s.requiresData);
      if (firstData >= 0) {
        const visible = TOUR_STEPS.filter(s => !s.requiresData || hasData);
        const idx = visible.findIndex(s => s.id === TOUR_STEPS[firstData].id);
        if (idx >= 0) setStepIndex(idx);
      }
    }
  }, [hasData, waitingForData, active]);

  // Auto-start on first visit
  useEffect(() => {
    if (!localStorage.getItem(TOUR_STORAGE_KEY)) {
      const t = setTimeout(() => startTour(), 600);
      return () => clearTimeout(t);
    }
  }, []);

  const startTour = useCallback(() => {
    setStepIndex(0);
    setActive(true);
    setWaitingForData(false);
  }, []);

  const endTour = useCallback(() => {
    setActive(false);
    setHighlight(null);
    setWaitingForData(false);
    localStorage.setItem(TOUR_STORAGE_KEY, 'true');
  }, []);

  const goNext = useCallback(() => {
    const steps = visibleStepsRef.current;
    const idx   = stepIndexRef.current;
    const step  = steps[idx];

    if (step?.id === 'run-button' && !hasDataRef.current) {
      setWaitingForData(true);
      return;
    }
    if (idx >= steps.length - 1) {
      endTour();
    } else {
      setStepIndex(idx + 1);
    }
  }, [endTour]);

  const goPrev = useCallback(() => {
    setWaitingForData(false);
    setStepIndex(i => Math.max(0, i - 1));
  }, []);

  return {
    active,
    currentStep,
    stepIndex,
    totalSteps,
    highlight,
    waitingForData,
    startTour,
    endTour,
    goNext,
    goPrev,
  };
}