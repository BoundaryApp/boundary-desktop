import React from 'react';
import { APP_NAME } from '../../../shared/buildIdentity';

export interface AppPasswordSlide {
  id: 'open' | 'security' | 'generate' | 'reauth' | 'paste';
  title: string;
  body: React.ReactNode;
  picture: React.ReactNode;
}

/** Shared look for every drawing: token colours only, plain boxes, text labels. */
const box = { fill: 'var(--surface-1)', stroke: 'var(--line-strong)', strokeWidth: 1 } as const;
const text = { fill: 'var(--text-muted)', fontSize: 12, fontFamily: 'inherit' } as const;
const strong = { ...text, fill: 'var(--text)' } as const;
const accent = { fill: 'var(--brand-dim)', stroke: 'var(--brand)', strokeWidth: 1.5 } as const;

function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <svg className="wb-cal-walk-art" viewBox="0 0 320 160" role="img" aria-label={label}>
      <rect x="1" y="1" width="318" height="158" rx="8" fill="var(--surface-0)" stroke="var(--line)" />
      {children}
    </svg>
  );
}

export const APP_PASSWORD_SLIDES: AppPasswordSlide[] = [
  {
    id: 'open',
    title: 'Open account.apple.com',
    body: 'Sign in with your Apple Account.',
    picture: (
      <Frame label="A browser window showing account.apple.com and a sign-in form">
        <rect x="30" y="20" width="260" height="120" rx="6" {...box} />
        <rect x="42" y="30" width="170" height="18" rx="9" fill="var(--surface-2)" stroke="var(--line)" />
        <text x="54" y="43" {...strong}>account.apple.com</text>
        <rect x="90" y="64" width="140" height="22" rx="4" fill="var(--surface-0)" stroke="var(--line)" />
        <text x="98" y="79" {...text}>Apple Account</text>
        <rect x="90" y="94" width="140" height="22" rx="4" fill="var(--surface-0)" stroke="var(--line)" />
        <text x="98" y="109" {...text}>Password</text>
      </Frame>
    ),
  },
  {
    id: 'security',
    title: 'Open App-Specific Passwords',
    body: (
      <>
        Go to <b>Sign-In and Security</b>, then <b>App-Specific Passwords</b>.
      </>
    ),
    picture: (
      <Frame label="A settings list with Sign-In and Security, then App-Specific Passwords highlighted">
        <rect x="30" y="20" width="260" height="120" rx="6" {...box} />
        <text x="46" y="44" {...text}>Personal Information</text>
        <rect x="40" y="54" width="240" height="26" rx="4" {...accent} />
        <text x="50" y="71" {...strong}>Sign-In and Security</text>
        <rect x="60" y="88" width="220" height="26" rx="4" {...accent} />
        <text x="70" y="105" {...strong}>App-Specific Passwords</text>
        <text x="46" y="130" {...text}>Devices</text>
      </Frame>
    ),
  },
  {
    id: 'generate',
    title: 'Generate an app-specific password',
    body: (
      <>
        Choose <b>Generate an app-specific password</b> and name it “{APP_NAME}”.
      </>
    ),
    picture: (
      <Frame label="A button labelled Generate an app-specific password and a name field containing the app name">
        <rect x="30" y="20" width="260" height="120" rx="6" {...box} />
        <rect x="50" y="36" width="220" height="26" rx="13" {...accent} />
        <text x="160" y="53" textAnchor="middle" {...strong}>Generate an app-specific password</text>
        <text x="50" y="86" {...text}>Name</text>
        <rect x="50" y="94" width="220" height="24" rx="4" fill="var(--surface-0)" stroke="var(--line-strong)" />
        <text x="58" y="110" {...strong}>{APP_NAME}</text>
      </Frame>
    ),
  },
  {
    id: 'reauth',
    title: 'Apple may ask for your Apple Account password',
    body: 'Enter it on Apple’s page if it does. The new app-specific password appears afterward.',
    picture: (
      <Frame label="A prompt asking for the Apple Account password, then a box showing a generated password">
        <rect x="24" y="30" width="130" height="100" rx="6" {...box} />
        <text x="36" y="54" {...text}>Enter your password</text>
        <rect x="36" y="64" width="106" height="22" rx="4" fill="var(--surface-0)" stroke="var(--line)" />
        <text x="44" y="79" {...text}>••••••••</text>
        <path d="M162 80 H182 M176 74 L182 80 L176 86" fill="none" stroke="var(--text-faint)" strokeWidth="1.5" />
        <rect x="190" y="30" width="106" height="100" rx="6" {...box} />
        <text x="202" y="54" {...text}>Your password</text>
        <rect x="198" y="64" width="90" height="22" rx="4" {...accent} />
        <text x="243" y="79" textAnchor="middle" {...strong}>abcd-efgh-…</text>
      </Frame>
    ),
  },
  {
    id: 'paste',
    title: 'Paste the password',
    body: 'Copy the password Apple shows and paste it below.',
    picture: (
      <Frame label="A field holding a four-group password and a Done button">
        <rect x="30" y="30" width="260" height="100" rx="6" {...box} />
        <text x="46" y="56" {...text}>App-specific password</text>
        <rect x="46" y="64" width="228" height="26" rx="4" fill="var(--surface-0)" stroke="var(--brand)" strokeWidth="1.5" />
        <text x="56" y="81" {...strong}>abcd-efgh-ijkl-mnop</text>
        <rect x="214" y="98" width="60" height="22" rx="11" {...accent} />
        <text x="244" y="113" textAnchor="middle" {...strong}>Done</text>
      </Frame>
    ),
  },
];
