'use client';

import { useState, useRef } from 'react';

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (text: string) => void;
}

export default function ImportModal({ isOpen, onClose, onImport }: ImportModalProps) {
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target?.result;
      if (typeof result === 'string') setText(result);
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function handleImport() {
    if (text.trim()) {
      onImport(text);
      setText('');
      onClose();
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-[rgba(0,0,0,0.6)] flex items-center justify-center z-[200] backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#1a1a1a] border border-tt-border rounded-2xl p-6 max-w-[500px] w-[90%]" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-4">Import CSV Data</h3>
        <p className="text-[13px] text-tt-muted mb-3">
          CSV should have columns: date, product, gmv, videos_posted, views, shipping, affiliate, ads
        </p>
        <div className="mb-3">
          <button
            onClick={() => fileRef.current?.click()}
            className="px-4 py-2 rounded-lg border border-tt-border bg-tt-card text-tt-text text-[13px] font-medium hover:bg-tt-card-hover transition-all"
          >
            Choose File
          </button>
          <input ref={fileRef} type="file" accept=".csv" onChange={handleFileChange} className="hidden" />
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Or paste CSV data here..."
          className="w-full min-h-[200px] bg-tt-input-bg border border-tt-input-border text-tt-text p-3 rounded-lg text-[13px] font-mono resize-y focus:outline-none focus:border-tt-cyan"
        />
        <div className="flex gap-2 justify-end mt-4">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-tt-border bg-tt-card text-tt-text text-[13px] font-medium hover:bg-tt-card-hover transition-all">
            Cancel
          </button>
          <button onClick={handleImport} className="px-4 py-2 rounded-lg bg-gradient-to-r from-tt-cyan to-[#4db8c0] text-black text-[13px] font-semibold hover:opacity-90 transition-opacity">
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
