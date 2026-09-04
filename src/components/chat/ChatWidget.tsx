'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useChatContext, describeView, greetingFor } from '@/lib/chat/context';

// Bottom-right launcher + overlay panel for the admin assistant.
//
// Renders NOTHING unless the signed-in user has app_metadata.role === 'admin' — same gate the
// API enforces. The client check is cosmetic (it only hides the button); /api/chat re-checks
// server-side, so a user who forces it open still gets a 403.

interface Msg { role: 'user' | 'assistant'; content: string }

export default function ChatWidget() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [toolNote, setToolNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { context } = useChatContext();
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    createClient().auth.getUser().then(({ data: { user } }) => {
      setIsAdmin(user?.app_metadata?.role === 'admin');
    });
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, busy, toolNote]);

  // Abort any in-flight request when the panel closes or the widget unmounts, so a
  // half-streamed answer can't land in a later conversation.
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setError(null);
    const next: Msg[] = [...msgs, { role: 'user', content: text }];
    setMsgs(next);
    setBusy(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: next, pageContext: context }),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || `Request failed (${res.status})`);
        setBusy(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let assistant = '';
      let started = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // NDJSON: complete lines only; keep the trailing partial in the buffer.
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: { type: string; text?: string; name?: string; message?: string };
          try { ev = JSON.parse(line); } catch { continue; }

          if (ev.type === 'text' && ev.text) {
            assistant += ev.text;
            setToolNote(null);
            setMsgs((prev) => {
              const copy = [...prev];
              if (started) copy[copy.length - 1] = { role: 'assistant', content: assistant };
              else copy.push({ role: 'assistant', content: assistant });
              return copy;
            });
            started = true;
          } else if (ev.type === 'tool') {
            setToolNote(ev.name === 'get_schedule' ? 'Reading the schedule…' : 'Reading the roster…');
          } else if (ev.type === 'error') {
            setError(ev.message ?? 'Something went wrong.');
          }
        }
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') setError('Connection lost. Try again.');
    } finally {
      setBusy(false);
      setToolNote(null);
      abortRef.current = null;
    }
  }, [input, busy, msgs, context]);

  if (!isAdmin) return null;

  const view = describeView(context);

  return (
    <>
      {/* Launcher. z-[60] clears the sticky z-50 header. */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open Lensed assistant"
          className="fixed z-[60] right-4 bottom-[calc(env(safe-area-inset-bottom)+1rem)] md:right-6 md:bottom-6 h-14 w-14 rounded-full bg-tt-cyan text-black shadow-lg shadow-black/40 flex items-center justify-center hover:scale-105 active:scale-95 transition-transform cursor-pointer"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        </button>
      )}

      {open && (
        <div className="fixed z-[60] inset-x-0 bottom-0 top-0 md:inset-auto md:right-6 md:bottom-6 md:top-auto md:w-[420px] md:h-[640px] md:max-h-[calc(100vh-6rem)] flex flex-col bg-tt-card border border-tt-border md:rounded-2xl shadow-2xl shadow-black/50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-tt-border bg-tt-card pt-[calc(env(safe-area-inset-top)+0.75rem)] md:pt-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-tt-text">Lensed Assistant</div>
              <div className="text-[11px] text-tt-muted truncate">
                {view ? `Looking at ${view}` : 'Read-only — answers from your data'}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {msgs.length > 0 && (
                <button
                  onClick={() => { abortRef.current?.abort(); setMsgs([]); setError(null); }}
                  className="text-[11px] px-2 py-1 rounded border border-tt-border text-tt-muted hover:text-tt-text cursor-pointer"
                >
                  New
                </button>
              )}
              <button
                onClick={() => { abortRef.current?.abort(); setOpen(false); }}
                aria-label="Close assistant"
                className="h-8 w-8 rounded-lg text-tt-muted hover:text-tt-text hover:bg-tt-card-hover flex items-center justify-center cursor-pointer"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {msgs.length === 0 && (
              <div className="text-sm text-tt-muted leading-relaxed">
                {greetingFor(context)}
                <div className="mt-3 text-[11px] text-tt-muted/70">
                  I read your live Lensed data to answer. I can’t change anything.
                </div>
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div className={
                  m.role === 'user'
                    ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-tt-cyan text-black px-3 py-2 text-sm whitespace-pre-wrap break-words'
                    : 'max-w-[92%] rounded-2xl rounded-bl-sm bg-tt-card-hover text-tt-text px-3 py-2 text-sm whitespace-pre-wrap break-words'
                }>
                  {m.content}
                </div>
              </div>
            ))}
            {(busy || toolNote) && (
              <div className="flex items-center gap-2 text-[11px] text-tt-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-tt-cyan animate-pulse" />
                {toolNote ?? 'Thinking…'}
              </div>
            )}
            {error && (
              <div className="text-[12px] text-tt-yellow bg-tt-yellow/10 border border-tt-yellow/30 rounded-lg px-3 py-2" role="alert">
                {error}
              </div>
            )}
          </div>

          <div className="border-t border-tt-border p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:pb-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
                }}
                rows={1}
                placeholder="Ask about your data…"
                className="flex-1 resize-none max-h-32 rounded-lg bg-tt-bg border border-tt-border px-3 py-2 text-sm text-tt-text placeholder:text-tt-muted focus:outline-none focus:ring-2 focus:ring-tt-cyan"
              />
              <button
                onClick={() => void send()}
                disabled={busy || !input.trim()}
                className="shrink-0 h-9 px-3 rounded-lg bg-tt-cyan text-black text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
