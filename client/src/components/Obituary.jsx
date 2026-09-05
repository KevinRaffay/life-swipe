import React, { useEffect, useState } from 'react';
import { fetchObituary } from '../api.js';
import { money } from './Hud.jsx';

// Written locally when there is no API key, when the model does not answer -
// and ALWAYS in demo mode, which never calls the model at all (see below).
function localObituary(stats) {
  const rich = stats.money > 500000;
  const broke = stats.ending === 'bankrupt';
  // A demo life that reached the swipe cap did not die, so it does not get an
  // obituary that says it did. `alive` is true here and `ending` is 'demo';
  // this is the closing card for the format, written to land as an ending
  // rather than as the game stopping.
  if (stats.ending === 'demo') {
    return {
      headline: `Still Alive At ${stats.age}, Which Is More Than Most Get Here`,
      obituary: [
        `You are not dead. You got ${stats.turns} swipes, which is what a demo is, and you spent them getting from 18 to ${stats.age} with ${money(stats.money)} and a job title that reads ${stats.career}.`,
        `Along the way you accumulated ${stats.flags.filter((f) => f !== 'lives_with_parents').length} things worth writing down${stats.relationships.length ? `, and ${stats.relationships.slice(0, 3).join(', ')}` : ', and nobody in particular'}. The rest of it - the mortgage, the diagnosis, the part where everyone you know turns fifty - is in the full game.`,
        `Health ${stats.health}/100, mood ${stats.happiness}/100. Not bad for a sample.`,
      ].join('\n\n'),
      epitaph: 'To be continued, allegedly.',
      source: 'local',
    };
  }
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
    'FATE',
    obit.headline,
    '',
    stats.ending === 'demo'
      ? `Survived the demo to ${stats.age}`
      : `Died at ${stats.age} - ${stats.ending === 'bankrupt' ? 'broke' : stats.cause}`,
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

export default function Obituary({ stats, history, demoMode = false, onRestart }) {
  const [obit, setObit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // DEMO MODE MAKES NO PROVIDER CALL, here or anywhere else. The deck's
    // refill gate covers play; this covers the one call that happens after
    // it. "Zero API calls" is the point of the format, and an obituary
    // request would be a call - so the demo takes the locally written one,
    // which is also instant, which a demo booth wants anyway.
    if (demoMode) {
      setObit(localObituary(stats));
      setLoading(false);
      return () => { cancelled = true; };
    }
    fetchObituary(stats, history).then((remote) => {
      if (cancelled) return;
      setObit(remote || localObituary(stats));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [stats, history, demoMode]);

  const onShare = async () => {
    const text = shareText(stats, obit);
    try {
      if (navigator.share) await navigator.share({ title: 'FATE', text });
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
        <p className="obituary__dates">
          {demoMode ? `18 - ${stats.age}` : `16 - ${stats.age}`}
        </p>
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
        <button className="btn btn--primary" onClick={onRestart}>
          {demoMode ? 'Run the demo again' : 'Live again'}
        </button>
      </div>

      {obit.source === 'local' && !demoMode && (
        <p className="obituary__footnote">
          Written locally. Set ANTHROPIC_API_KEY for an obituary with opinions.
        </p>
      )}
      {demoMode && (
        <p className="obituary__footnote">
          That was the demo &mdash; a fixed deck, no model, no network. The full
          game runs from 16 until it actually ends.
        </p>
      )}
    </div>
  );
}
