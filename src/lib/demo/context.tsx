'use client';

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

interface DemoContextValue {
  isDemo: boolean;
  enterDemo: () => void;
  exitDemo: () => void;
}

const DemoContext = createContext<DemoContextValue>({
  isDemo: false,
  enterDemo: () => {},
  exitDemo: () => {},
});

const DEMO_STORAGE_KEY = 'lensed_demo_mode';

export function DemoProvider({ children }: { children: ReactNode }) {
  const [isDemo, setIsDemo] = useState(false);

  // On mount, check if demo mode was previously activated
  useEffect(() => {
    const stored = sessionStorage.getItem(DEMO_STORAGE_KEY);
    if (stored === 'true') {
      setIsDemo(true);
    }
  }, []);

  function enterDemo() {
    sessionStorage.setItem(DEMO_STORAGE_KEY, 'true');
    setIsDemo(true);
  }

  function exitDemo() {
    sessionStorage.removeItem(DEMO_STORAGE_KEY);
    setIsDemo(false);
  }

  return (
    <DemoContext.Provider value={{ isDemo, enterDemo, exitDemo }}>
      {children}
    </DemoContext.Provider>
  );
}

export function useDemo() {
  return useContext(DemoContext);
}
