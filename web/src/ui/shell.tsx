import type { ComponentChildren } from 'preact';

/** Brix mark (design/brand/assets/logo-mark.svg), white only. */
export function LogoMark({ class: cls }: { class?: string }) {
  return (
    <svg viewBox="0 0 177.392 177.392" fill="currentColor" aria-hidden="true" class={cls}>
      <path d="M 138.227 177.392 L 104.822 143.987 C 95.916 135.081 81.476 135.081 72.569 143.987 L 39.164 177.392 L 23.038 161.266 L 56.443 127.861 L 56.862 127.446 C 74.566 110.186 102.826 110.186 120.529 127.446 L 120.949 127.861 L 154.354 161.266 L 138.227 177.392 Z" />
      <path d="M 49.946 56.862 C 67.206 74.566 67.206 102.826 49.946 120.529 L 49.532 120.949 L 16.127 154.354 L 0 138.227 L 33.405 104.822 C 42.311 95.916 42.311 81.476 33.405 72.569 L 0 39.164 L 16.127 23.038 L 49.532 56.443 L 49.946 56.862 Z" />
      <path d="M 143.987 72.57 C 135.08 81.476 135.08 95.916 143.987 104.823 L 177.392 138.228 L 161.265 154.354 L 127.86 120.949 L 127.446 120.53 C 110.185 102.826 110.185 74.566 127.446 56.863 L 127.86 56.443 L 161.265 23.038 L 177.392 39.165 L 143.987 72.57 Z" />
      <path d="M 120.949 49.532 L 120.529 49.946 C 102.826 67.206 74.566 67.206 56.862 49.946 L 56.443 49.532 L 23.038 16.127 L 39.164 0 L 72.569 33.405 C 81.476 42.311 95.916 42.311 104.822 33.405 L 138.227 0 L 154.354 16.127 L 120.949 49.532 Z" />
    </svg>
  );
}

export function Shell({
  children,
  navigate,
}: {
  children: ComponentChildren;
  navigate: (path: string) => void;
}) {
  const link = (path: string) => (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(path);
  };
  return (
    <div class="mx-auto flex min-h-dvh max-w-[1120px] flex-col px-5 sm:px-8">
      <header class="flex h-16 items-center justify-between border-b border-line-soft sm:h-[72px]">
        <a
          href="/"
          onClick={link('/')}
          class="flex min-h-11 items-center gap-3 rounded-sm no-underline"
        >
          <LogoMark class="size-[26px] text-white" />
          <span class="font-title text-[22px] leading-none font-medium tracking-[-0.01em]">
            Brix <span class="font-normal text-fg-3">Share</span>
          </span>
        </a>
        <nav aria-label="Main" class="flex gap-1 text-sm font-medium text-fg-2 sm:gap-6">
          <a
            href="/"
            onClick={link('/')}
            class="flex min-h-11 items-center rounded-sm px-2 no-underline hover:underline"
          >
            New secret
          </a>
          <a
            href="/how-it-works"
            onClick={link('/how-it-works')}
            class="flex min-h-11 items-center rounded-sm px-2 no-underline hover:underline"
          >
            How it works
          </a>
        </nav>
      </header>
      <main id="main" class="flex-1 py-8 sm:py-12">
        {children}
      </main>
      <footer class="flex flex-wrap justify-between gap-4 border-t border-line-soft pt-6 pb-10 text-xs text-muted">
        <p>Encrypted in your browser. Brix never sees the secret, the key or the file names.</p>
        <p class="flex gap-3">
          <a
            href="/how-it-works"
            onClick={link('/how-it-works')}
            class="text-fg-3 no-underline hover:underline"
          >
            How it works
          </a>
          <span aria-hidden="true">·</span>
          <a
            href="/privacy"
            onClick={link('/privacy')}
            class="text-fg-3 no-underline hover:underline"
          >
            Privacy
          </a>
          <span aria-hidden="true">·</span>
          <a
            href="/acceptable-use"
            onClick={link('/acceptable-use')}
            class="text-fg-3 no-underline hover:underline"
          >
            Acceptable use
          </a>
          <span aria-hidden="true">·</span>
          <a
            href="https://brix.money"
            rel="noopener noreferrer"
            class="text-fg-3 no-underline hover:underline"
          >
            brix.money
          </a>
        </p>
      </footer>
    </div>
  );
}
