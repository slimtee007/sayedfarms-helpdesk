import { createContext, useCallback, useContext, useRef, useState } from 'react';

const ToastContext = createContext(() => {});

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const id = useRef(0);

  const show = useCallback((message, kind = 'success') => {
    id.current += 1;
    setToast({ message, kind, key: id.current });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div key={toast.key} className="pointer-events-none fixed inset-x-0 top-0 z-[90] flex justify-center safe-top">
          <div
            className={`animate-fade mt-3 max-w-[88%] rounded-full px-4 py-2 text-[13px] font-medium shadow-lg ${
              toast.kind === 'error' ? 'bg-red-600 text-white' : 'bg-slate-900 text-white'
            }`}
          >
            {toast.message}
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
