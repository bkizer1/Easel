/**
 * Easel — VoiceButton component.
 *
 * Provides Web Speech API (SpeechRecognition) voice-to-text input for the
 * ChatPanel instruction field. Gated behind featureFlags.voiceInput and
 * gracefully degrades to a disabled no-op when the API is unavailable.
 *
 * On successful transcription it pushes the transcript text into the
 * instruction via the provided onTranscript callback. The caller is
 * responsible for appending or replacing the textarea value.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';
import { useEaselStore } from '../store';
import { Tooltip } from './Tooltip';

/* -------------------------------------------------------------------------- */
/*  SpeechRecognition shim                                                   */
/* -------------------------------------------------------------------------- */

// Electron uses Chromium so webkit-prefixed APIs are available in the renderer.
const SpeechRecognition =
  (typeof window !== 'undefined' &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition)) ||
  null;

interface Props {
  /** Called with the final transcribed text so the parent can append it. */
  onTranscript(text: string): void;
  /** Whether a submission is currently in flight (disables the button). */
  disabled?: boolean;
}

type VoiceState = 'idle' | 'listening' | 'processing';

export function VoiceButton({ onTranscript, disabled = false }: Props): React.ReactElement {
  const settings = useEaselStore((s) => s.settings);
  const voiceEnabled = settings?.featureFlags.voiceInput ?? false;

  const [state, setState] = useState<VoiceState>('idle');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any | null>(null);

  const isAvailable = SpeechRecognition !== null && voiceEnabled;

  const stop = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignore: may already be stopped.
      }
      recognitionRef.current = null;
    }
    setState('idle');
  }, []);

  const start = useCallback(() => {
    if (!SpeechRecognition) return;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
    const rec = new SpeechRecognition();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    rec.lang = navigator.language || 'en-US';
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    rec.continuous = false;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    rec.interimResults = false;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    rec.onstart = () => setState('listening');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    rec.onresult = (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
      setState('processing');
      const transcript = Array.from(event.results)
        .map((r) => r[0].transcript)
        .join(' ')
        .trim();
      if (transcript) {
        onTranscript(transcript);
      }
      setState('idle');
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    rec.onerror = () => setState('idle');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    rec.onend = () => setState('idle');

    recognitionRef.current = rec;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    rec.start();
  }, [onTranscript]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => stop();
  }, [stop]);

  function handleClick(): void {
    if (state === 'listening') {
      stop();
    } else {
      start();
    }
  }

  if (!isAvailable) {
    return (
      <Tooltip label="Voice input unavailable (enable in Settings → Feature flags)" side="top">
        <button
          type="button"
          aria-label="Voice input unavailable"
          aria-disabled
          tabIndex={-1}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-700 cursor-not-allowed opacity-40"
        >
          <MicOff className="w-4 h-4" />
        </button>
      </Tooltip>
    );
  }

  const isListening = state === 'listening';
  const isProcessing = state === 'processing';

  return (
    <Tooltip
      label={isListening ? 'Stop recording' : 'Start voice input'}
      side="top"
    >
      <button
        type="button"
        aria-label={isListening ? 'Stop recording' : 'Start voice input'}
        onClick={handleClick}
        disabled={disabled || isProcessing}
        className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-150 ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 active:scale-90 ${
          isListening
            ? 'bg-rose-600/20 text-rose-400 hover:bg-rose-600/30'
            : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.07]'
        } disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        {isProcessing ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : isListening ? (
          <Mic className="w-4 h-4 animate-pulse" />
        ) : (
          <Mic className="w-4 h-4" />
        )}
      </button>
    </Tooltip>
  );
}
