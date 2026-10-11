import './styles.css';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CreatedSecret } from './create-flow.ts';
import { confirmLeave } from './leave-guard.ts';
import { parseRoute, pathOf, takeInitialRoute, type Route } from './router.ts';
import {
  AcceptableUseScreen,
  HowItWorksScreen,
  NotFoundScreen,
  PrivacyScreen,
} from './screens/about.tsx';
import { CreateScreen } from './screens/create.tsx';
import { ManageScreen } from './screens/manage.tsx';
import { ResultScreen } from './screens/result.tsx';
import { RevealScreen } from './screens/reveal.tsx';
import { Shell } from './ui/shell.tsx';

type View = Route | { name: 'result'; secret: CreatedSecret };

const TITLES: Record<View['name'], string> = {
  create: 'Brix Share',
  result: 'Secret created · Brix Share',
  reveal: 'Secret · Brix Share',
  manage: 'Manage secret · Brix Share',
  how: 'How it works · Brix Share',
  privacy: 'Privacy · Brix Share',
  acceptable: 'Acceptable use · Brix Share',
  notfound: 'Not found · Brix Share',
};

function App({ initial }: { initial: Route }) {
  const [view, setView] = useState<View>(initial);
  // The links of the last created secret, kept in memory only, so going back from the manage page shows them
  // again instead of losing them. Never in history.state, which browsers may persist.
  const lastCreated = useRef<CreatedSecret | null>(null);
  const currentPath = useRef(location.pathname);
  // In-page target for links like /about#privacy; never written to the URL.
  const pendingAnchor = useRef<string | null>(null);

  useEffect(() => {
    // Back/forward: keys are never in the URL after load, so restored routes come without them.
    const onPop = () => {
      if (!confirmLeave()) {
        history.pushState(null, '', currentPath.current);
        return;
      }
      currentPath.current = location.pathname;
      const route = parseRoute(location.pathname, '');
      setView(
        route.name === 'create' && lastCreated.current
          ? { name: 'result', secret: lastCreated.current }
          : route,
      );
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    // Never derived from the secret (PLAN section 6).
    document.title = TITLES[view.name];
    const anchor = pendingAnchor.current;
    pendingAnchor.current = null;
    const target = anchor ? document.getElementById(anchor) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [view]);

  const go = (next: View, path: string) => {
    if (!confirmLeave()) return;
    if (location.pathname !== path) history.pushState(null, '', path);
    currentPath.current = path;
    setView(next);
  };
  const navigate = (target: string) => {
    const [path = '/', anchor] = target.split('#');
    pendingAnchor.current = anchor ?? null;
    go(parseRoute(path, ''), path);
  };
  const home = () => navigate('/');
  const createAnother = () => {
    lastCreated.current = null;
    go({ name: 'create' }, '/');
  };

  let screen;
  switch (view.name) {
    case 'create':
      screen = (
        <CreateScreen
          onCreated={(secret) => {
            lastCreated.current = secret;
            go({ name: 'result', secret }, '/');
          }}
        />
      );
      break;
    case 'result':
      screen = (
        <ResultScreen
          secret={view.secret}
          onAnother={createAnother}
          onManage={() => {
            const route: Route = {
              name: 'manage',
              id: view.secret.id,
              token: view.secret.manageToken,
            };
            go(route, pathOf(route));
          }}
        />
      );
      break;
    case 'reveal':
      screen = <RevealScreen key={view.id} id={view.id} linkKey={view.key} onNew={home} />;
      break;
    case 'manage':
      screen = <ManageScreen key={view.id} id={view.id} token={view.token} onNew={home} />;
      break;
    case 'how':
      screen = <HowItWorksScreen />;
      break;
    case 'privacy':
      screen = <PrivacyScreen />;
      break;
    case 'acceptable':
      screen = <AcceptableUseScreen />;
      break;
    case 'notfound':
      screen = <NotFoundScreen onHome={home} />;
      break;
  }
  // The header's "New secret" always starts fresh.
  return (
    <Shell navigate={(path) => (path === '/' ? createAnother() : navigate(path))}>{screen}</Shell>
  );
}

render(<App initial={takeInitialRoute()} />, document.getElementById('app')!);
