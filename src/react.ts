// nexugen/react: Pilot for your users in a React app, on any host.
//
//   import { PilotForUsers } from 'nexugen/react';
//   <PilotForUsers appKey="pa_..." getAuthHeaders={async () => ({ Authorization: `Bearer ${token}` })} />
//
// It loads the same widget as the script tag and hands it your app's hooks. Your token is
// read in the browser and added to your own API calls there; it never goes to Nexugen.

import { useEffect, useRef } from 'react';

export interface PilotUser {
  signedIn: boolean;
  name?: string;
}

export interface PilotForUsersProps {
  /** The pa_... key from "Pilot for your users" in Nexugen. */
  appKey: string;
  /** Headers your API needs, e.g. { Authorization: 'Bearer …' }. Omit for cookie sessions. */
  getAuthHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Who is signed in: for "signed-in people only" and a friendlier chat. */
  user?: PilotUser | null | (() => PilotUser | null | Promise<PilotUser | null>);
  /** Your API's address when it is not this site, e.g. https://api.example.com. */
  apiBase?: string;
  /** Send cookies to that other API too. */
  credentials?: 'include' | 'omit';
  /** The widget's address. Leave it out. */
  src?: string;
}

interface Hooks {
  auth: () => Promise<{ headers: Record<string, string> }>;
  user: () => Promise<PilotUser | null>;
  readonly apiBase: string | undefined;
  readonly credentials: 'include' | 'omit' | undefined;
}

declare global {
  interface Window { NexugenPilot?: Hooks }
}

export const WIDGET_SRC = 'https://nexugen.app/widget/pilot.js';

/** The hooks object the widget reads, always calling the latest props. */
export function pilotHooks(latest: { current: PilotForUsersProps }): Hooks {
  return {
    auth: async () => ({ headers: latest.current.getAuthHeaders ? await latest.current.getAuthHeaders() : {} }),
    user: async () => {
      const u = latest.current.user;
      return typeof u === 'function' ? await u() : u ?? null;
    },
    get apiBase() { return latest.current.apiBase; },
    get credentials() { return latest.current.credentials; },
  };
}

/** Add the widget's script once. */
export function loadWidget(doc: Document, appKey: string, src = WIDGET_SRC): boolean {
  if (!/^pa_[A-Za-z0-9_-]{8,40}$/.test(appKey)) return false;
  if (doc.querySelector(`script[data-app="${appKey}"]`)) return false;
  const s = doc.createElement('script');
  s.src = src;
  s.async = true;
  s.setAttribute('data-app', appKey);
  doc.body.appendChild(s);
  return true;
}

/** Renders nothing itself: the chat draws in its own corner, isolated from your styles. */
export function PilotForUsers(props: PilotForUsersProps): null {
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    window.NexugenPilot = pilotHooks(latest);
    loadWidget(document, props.appKey, props.src);
  }, [props.appKey, props.src]);
  return null;
}
