'use client';

import { useState } from 'react';
import { parseDFSText, type ParsedPlayer } from '../lib/parsers';

interface PasteInputProps {
  onParsed: (players: ParsedPlayer[]) => void;
  disabled?: boolean;
}

export default function PasteInput({ onParsed, disabled }: PasteInputProps) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ParsedPlayer[]>([]);

  function handleChange(value: string) {
    setText(value);
    if (value.trim()) {
      setPreview(parseDFSText(value));
    } else {
      setPreview([]);
    }
  }

  function handleSubmit() {
    if (preview.length > 0) {
      onParsed(preview);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
          Paste DFS Lines
        </h3>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          PrizePicks, Underdog, Pick6, etc.
        </span>
      </div>

      <textarea
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        disabled={disabled}
        placeholder={`Paste your picks here...\n\nExample:\nLeBron James\nMore\nPoints\n26.5`}
        rows={6}
        className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none disabled:opacity-50"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-subtle)',
          color: 'var(--text-primary)',
        }}
      />

      {preview.length > 0 && (
        <div className="rounded-lg p-3" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}>
          <p className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>
            Preview ({preview.length} player{preview.length !== 1 ? 's' : ''} found)
          </p>
          <div className="space-y-1">
            {preview.map((p, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span style={{ color: 'var(--text-primary)' }}>{p.playerName}</span>
                <span style={{ color: 'var(--text-muted)' }}>
                  {p.direction === 'over' ? 'O' : 'U'} {p.line} {p.statType}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={preview.length === 0 || disabled}
        className="w-full rounded-lg py-2.5 font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ background: 'var(--accent)' }}
      >
        Analyze Pasted Props ({preview.length})
      </button>
    </div>
  );
}
