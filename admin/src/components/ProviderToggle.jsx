import React from 'react';

/**
 * The storyteller switch: which backend writes the content, for every life
 * this server deals - this is a SERVER-WIDE toggle, not a per-player choice
 * (that is documented future work). Runtime-only: LLM_PROVIDER is the boot
 * default and a restart reverts to it, which is what the "runtime" tag warns
 * about whenever the active provider differs from the boot one.
 *
 * A provider that could not serve (no key, no OLLAMA_MODEL) renders disabled
 * with the reason in its tooltip; a switch that fails server-side (Ollama
 * down, model not pulled) surfaces through the normal toast, so this
 * component only renders state and asks.
 */
const OPTIONS = [
  ['anthropic', 'Anthropic', 'ANTHROPIC_API_KEY is not set'],
  ['ollama', 'Ollama', 'OLLAMA_MODEL is not set'],
];

export default function ProviderToggle({ status, busy, onSwitch }) {
  if (!status) return null;
  return (
    <span
      className="provider-toggle"
      title="Which model plays the storyteller. Server-wide; resets to LLM_PROVIDER on restart."
    >
      <span className="muted small">storyteller</span>
      {OPTIONS.map(([key, label, unconfigured]) => {
        const info = status.available[key] || {};
        const active = status.provider === key;
        return (
          <button
            key={key}
            className={'btn' + (active ? ' is-on' : '')}
            disabled={busy || active || !info.configured}
            title={info.configured ? (info.model || '') : unconfigured}
            onClick={() => onSwitch(key)}
          >
            {label}
          </button>
        );
      })}
      <span className="muted small">
        {status.model}
        {status.provider !== status.bootProvider ? ' · runtime, reverts on restart' : ''}
      </span>
    </span>
  );
}
