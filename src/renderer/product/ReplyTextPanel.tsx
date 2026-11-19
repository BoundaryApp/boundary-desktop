import React, { useState } from 'react';
import { Streamdown } from 'streamdown';
import { Segmented } from '../components/ui/segmented';
import { SettingsRow, SettingsSection } from '../components/settings/SettingsSection';
import { useReplyText } from '../replyText';
import {
  DEFAULT_REPLY_TEXT,
  REPLY_TEXT_RANGES,
  isDefaultReplyText,
  type ReplyTextFace,
  type ReplyTextPreference,
} from '../../shared/replyText';
import { Button } from '../components/ui/button';

type SliderKey = keyof typeof REPLY_TEXT_RANGES;

const SLIDERS: Array<{ key: SliderKey; label: string; hint?: string; format: (value: number) => string }> = [
  { key: 'size', label: 'Size', format: (value) => `${value}px` },
  { key: 'lineHeight', label: 'Line height', format: (value) => String(value) },
  { key: 'paragraphGap', label: 'Paragraph spacing', hint: 'Space after paragraphs, lists and code.', format: (value) => `${value}em` },
  { key: 'listGap', label: 'List item spacing', format: (value) => `${value}em` },
  { key: 'weight', label: 'Weight', format: (value) => String(value) },
];

type Sample = 'lists' | 'paragraphs';

const SAMPLE_PROMPT: Record<Sample, string> = {
  lists: 'How do I keep the agent off the other machines on my network?',
  paragraphs: 'Why does the first reply after a restart take longer?',
};

const SAMPLE_REPLY: Record<Sample, string> = {
  lists: `There are three ways to keep the agent's container off your network. They trade setup time for how much you can see afterwards.

## Options

- **Network policy.** Block private address ranges at the bridge. Fast to set up, but a mistyped rule fails open.
- **A separate VM.** The strongest isolation; it costs about 1 GB of memory and a slower start.
- **An egress proxy.** Every request goes through one allow-list, which also keeps a log of what was tried.

1. **Turn on the proxy.** Switch it on in Settings.

   Existing chats pick it up on their next turn.

2. **Add the domains your tools need.**
3. **Check for leaks.** Run \`doctor --network\` and confirm it reports no direct routes.

If you want, I can write the allow-list for the add-ons you have installed.`,
  paragraphs: `The first turn after a restart pays for things later turns don't: loading the model into memory, filling the prompt cache, and starting any add-ons the chat uses.

Loading the model is the largest part. A 14B model at 4-bit is about 8 GB, and reading that into memory takes 10 to 20 seconds on most Macs. Once it's loaded, later turns skip this until the model is unloaded for being idle.

The prompt cache matters less on its own, but it adds up with long system prompts. The first turn processes the whole prompt; later turns reuse what's cached and only process what's new.`,
};

/** Settings › Reply text: how assistant replies are set, with a live preview. */
export const ReplyTextPanel: React.FC = () => {
  const [preference, setPreference] = useReplyText();
  const [sample, setSample] = useState<Sample>('lists');
  const update = (change: Partial<ReplyTextPreference>) => setPreference({ ...preference, ...change });
  const serif = preference.face === 'serif';

  return (
    <>
      <SettingsSection id="settings-reply-text" title="Reply text">
        <SettingsRow label="Typeface" hint="Sans uses the same face as your messages.">
          <Segmented<ReplyTextFace>
            aria-label="Typeface"
            value={preference.face}
            onChange={(face) => update({ face })}
            options={[
              { value: 'serif', label: 'Serif' },
              { value: 'sans', label: 'Sans' },
            ]}
          />
        </SettingsRow>
        {SLIDERS.map(({ key, label, hint, format }) => {
          const range = REPLY_TEXT_RANGES[key];
          const disabled = key === 'weight' && serif;
          const id = `reply-text-${key}`;
          return (
            <SettingsRow
              key={key}
              label={<label htmlFor={id}>{label}</label>}
              hint={disabled ? 'The serif face comes in fixed weights. Switch to Sans to change it.' : hint}
            >
              <div className="wb-reply-text-slider">
                <input
                  id={id}
                  type="range"
                  min={range.min}
                  max={range.max}
                  step={range.step}
                  value={disabled ? DEFAULT_REPLY_TEXT.weight : preference[key]}
                  disabled={disabled}
                  onChange={(event) => update({ [key]: Number(event.target.value) })}
                />
                <output htmlFor={id}>{format(disabled ? DEFAULT_REPLY_TEXT.weight : preference[key])}</output>
              </div>
            </SettingsRow>
          );
        })}
        <SettingsRow label="Default" hint="Serif, 15.5px, line height 1.7.">
          <Button
            variant="secondary"
            type="button"
            disabled={isDefaultReplyText(preference)}
            onClick={() => setPreference(DEFAULT_REPLY_TEXT)}
          >
            Reset to default
          </Button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="settings-reply-text-preview" title="Preview">
        <Segmented<Sample>
          className="wb-reply-text-sample"
          aria-label="Preview reply"
          value={sample}
          onChange={setSample}
          options={[
            { value: 'lists', label: 'With lists' },
            { value: 'paragraphs', label: 'Paragraphs' },
          ]}
        />
        <div className="wb-reply-text-preview" aria-label="Reply preview" role="group">
          <div className="wb-msg is-user">
            <div className="wb-bubble">{SAMPLE_PROMPT[sample]}</div>
          </div>
          <div className="wb-msg is-assistant">
            <div className="wb-prose">
              <Streamdown className="wb-streamdown">{SAMPLE_REPLY[sample]}</Streamdown>
            </div>
          </div>
        </div>
      </SettingsSection>
    </>
  );
};
