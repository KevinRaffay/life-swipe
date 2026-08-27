import React, { useEffect, useState } from 'react';
import { fetchObituary } from '../api.js';
import { money } from './Hud.jsx';

// Written locally when there is no API key, or when the model does not answer.
function localObituary(stats) {
  const rich = stats.money > 500000;
  const broke = stats.ending === 'bankrupt';
  const headline = broke
    ? `Outlived By Their Own Debt At ${stats.age}`
    : `Dead At ${stats.age}, ${rich ? 'Comfortably' : 'Approximately On Schedule'}`;

  const flagLine = stats.flags.filter((f) => f !== 'lives_with_parents').slice(-4).join(', ');
  const paragraphs = [
    broke
      ? `You died at ${stats.age} in the accounting sense, which is the sense that gets recorded. The last job on file was ${stats.career}. The number at the bottom was ${money(stats.money)}, and it had been trending that way for some time.`
      : `You died at ${stats.age} of ${stats.cause}. You left ${money(stats.money)}, ${stats.kids} ${stats.kids === 1 ? 'child' : 'children'}, and a job title that read ${stats.career}.`,
    `Across ${stats.turns} decisions you accumulated a life: ${flagLine || 'remarkably little that anyone wrote down'}. ${
      stats.relationships.length
        ? `Survived by ${stats.relationships.slice(0, 3).join(', ')}.`
        : 'Survived by nobody in particular.'
    }`,
    `You finished with ${stats.happiness}/100 happiness and ${stats.health}/100 health, which is either a tragedy or a rounding error depending on who is reading.`,
  ];

  return {
    headline,
    obituary: paragraphs.join('\n\n'),
    epitaph: broke ? 'Balanced nothing, least of all the books.' : 'Made choices. Some of them twice.',
    source: 'local',
  };
}

function shareText(stats, obit) {
  const lines = [
    'LIFE SWIPE',
    obit.headline,
    '',
    `Died at ${stats.age} - ${stats.ending === 'bankrupt' ? 'broke' : stats.cause}`,
    `Money: ${money(stats.money)}`,
    `Health ${stats.health}/100 - Mood ${stats.happiness}/100`,
    `Career: ${stats.career}`,
    `Swipes: ${stats.turns}`,
    `CREDITS: ${stats.credits.toLocaleString('en-US')}`,
    '',
    obit.epitaph ? `"${obit.epitaph}"` : '',
  ];
  return lines.filter((l) => l !== undefined).join('\n');
}

export default function Obituary({ stats, history, onRestart }) {
  const [obit, setObit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchObituary(stats, history).then((remote) => {
      if (cancelled) return;
      setObit(remote || localObituary(stats));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [stats, history]);

  const onShare = async () => {
    const text = shareText(stats, obit);
    try {
      if (navigator.share) await navigator.share({ title: 'Life Swipe', text });
      else await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // The user dismissed the share sheet. Not an error worth reporting.
    }
  };

  if (loading) {
    return (
      <div className="obituary obituary--loading">
        <p className="obituary__loading-text">Settling the estate&hellip;</p>
      </div>
    );
  }

  return (
    <div className="obituary">
      <div className="obituary__stone">
        <p className="obituary__dates">16 &ndash; {stats.age}</p>
        <h1 className="obituary__headline">{obit.headline}</h1>
        {obit.epitaph && <p className="obituary__epitaph">&ldquo;{obit.epitaph}&rdquo;</p>}
      </div>

      <div className="obituary__body">
        {obit.obituary.split(/\n\n+/).map((p, i) => <p key={i}>{p}</p>)}
      </div>

      <dl className="final-stats">
        <div><dt>Age</dt><dd>{stats.age}</dd></div>
        <div><dt>Money</dt><dd className={stats.money < 0 ? 'is-broke' : ''}>{money(stats.money)}</dd></div>
        <div><dt>Health</dt><dd>{stats.health}</dd></div>
        <div><dt>Mood</dt><dd>{stats.happiness}</dd></div>
        <div><dt>Swipes</dt><dd>{stats.turns}</dd></div>
        <div><dt>Children</dt><dd>{stats.kids}</dd></div>
      </dl>

      <div className="credits">
        <span className="credits__label">CREDITS</span>
        <span className="credits__value">{stats.credits.toLocaleString('en-US')}</span>
      </div>

      <div className="obituary__actions">
        <button className="btn btn--ghost" onClick={onShare}>
          {copied ? 'Copied' : 'Share as text'}
        </button>
        <button className="btn btn--primary" onClick={onRestart}>Live again</button>
      </div>

      {obit.source === 'local' && (
        <p className="obituary__footnote">
          Written locally. Set ANTHROPIC_API_KEY for an obituary with opinions.
        </p>
      )}
    </div>
  );
}
