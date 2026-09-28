import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquare, Plus, Send } from 'lucide-react';
import { socket } from '../lib/api.js';
import { useSession } from '../context/SessionContext.jsx';

/**
 * Live IT support chat — the mobile version of the portal's floating widget.
 * Messages broadcast to everyone in the session and are not persisted, so
 * this is for quick questions; anything that needs tracking points to the
 * new-request screen.
 */
export default function LiveChatScreen() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const bottomRef = useRef(null);
  const myRoleSide = user?.role === 'agent' ? 'agent' : 'user';

  useEffect(() => {
    const handler = (msg) => {
      setMessages((prev) => (msg?.id && prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    };
    socket.on('receive_message', handler);
    return () => { socket.off('receive_message', handler); };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    // The server stamps id / sender / senderName / time from the
    // authenticated socket and broadcasts to every session.
    socket.emit('send_message', { text });
    setInput('');
  };

  return (
    <div className="flex h-full flex-col">
      <div className="bg-gradient-to-r from-brand to-brand-deep px-5 pb-5 pt-3 text-white safe-top">
        <div className="flex items-center gap-2.5 pt-1">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
          </span>
          <div>
            <h1 className="text-[18px] font-bold tracking-tight">Live IT Chat</h1>
            <p className="text-[12px] text-blue-100">Quick questions, answered in real time</p>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto overscroll-contain bg-slate-100/60 px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-sm">
              <MessageSquare className="h-5 w-5 text-brand" />
            </span>
            <p className="text-[14px] font-semibold text-slate-700">Say hello to IT</p>
            <p className="mt-1 text-[13px] leading-5 text-slate-400">
              Start the conversation and an available IT agent will reply here.
            </p>
            <button
              type="button"
              onClick={() => navigate('/new')}
              className="pressable mt-4 flex items-center gap-1.5 rounded-full border border-brand/20 bg-white px-4 py-2 text-[13px] font-semibold text-brand shadow-sm"
            >
              <Plus className="h-3.5 w-3.5" />
              Need something tracked? Raise a request
            </button>
          </div>
        ) : (
          messages.map((m) => {
            const mine = m.sender === myRoleSide;
            return (
              <div key={m.id || `${m.time}-${m.senderName}-${m.text}`} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                <div
                  className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 text-[14px] leading-5 shadow-sm ${
                    mine
                      ? 'rounded-br-md bg-brand text-white'
                      : 'rounded-bl-md border border-slate-100 bg-white text-slate-800'
                  }`}
                >
                  {!mine && (
                    <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      {m.sender === 'agent' ? `IT · ${m.senderName || 'Agent'}` : m.senderName || 'Staff'}
                    </span>
                  )}
                  <span className="whitespace-pre-wrap">{m.text}</span>
                </div>
                <span className="mt-1 px-1 text-[10px] text-slate-400">{m.time}</span>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={send} className="flex items-end gap-2 border-t border-slate-200 bg-white px-3 py-2.5 safe-bottom">
        <textarea
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message to IT…"
          className="max-h-32 flex-1 resize-none rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-[15px] text-slate-800 placeholder:text-slate-400 focus:border-brand focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand/20"
        />
        <button
          type="submit"
          disabled={!input.trim()}
          aria-label="Send message"
          className="pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-white shadow-md shadow-brand/30 transition disabled:opacity-40 active:bg-brand-dark"
        >
          <Send className="h-4.5 w-4.5" />
        </button>
      </form>
    </div>
  );
}
