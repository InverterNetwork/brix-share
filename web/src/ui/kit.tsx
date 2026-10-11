import { Fragment, type ButtonHTMLAttributes, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, Copy } from 'lucide-preact';

type Variant = 'primary' | 'outline' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary:
    'bg-orange text-white hover:bg-orange-hover hover:shadow-glow disabled:hover:bg-orange disabled:hover:shadow-none',
  outline: 'border border-line-mid text-white hover:border-line-strong',
  ghost: 'text-fg-2 hover:text-orange',
  danger: 'border border-error/40 text-error hover:border-error hover:bg-error/10',
};
const sizes: Record<Size, string> = {
  sm: 'min-h-11 px-4 text-[13px] sm:min-h-9',
  md: 'min-h-11 px-[22px] text-sm',
  lg: 'min-h-12 px-7 text-[15px]',
};

export interface ButtonProps extends Omit<ButtonHTMLAttributes, 'size' | 'type'> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  type?: 'button' | 'submit';
  disabled?: boolean;
}

export function Button({
  variant = 'outline',
  size = 'md',
  block,
  class: cls,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      class={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-pill font-medium tracking-[0.01em] whitespace-nowrap transition-all active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 ${variants[variant]} ${sizes[size]} ${block ? 'w-full' : ''} ${(cls as string | undefined) ?? ''}`}
      {...rest}
    />
  );
}

export function Panel({
  children,
  class: cls,
  as = 'section',
}: {
  children: ComponentChildren;
  class?: string;
  as?: 'section' | 'div';
}) {
  const Tag = as;
  return (
    <Tag class={`rounded-lg border border-line-soft bg-raised p-5 sm:p-6 ${cls ?? ''}`}>
      {children}
    </Tag>
  );
}

export function PanelTitle({
  children,
  hint,
}: {
  children: ComponentChildren;
  hint?: ComponentChildren;
}) {
  return (
    <h2 class="mb-4 text-sm font-semibold text-white">
      {children}
      {hint && <span class="ml-2 font-normal text-muted">{hint}</span>}
    </h2>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
  class: cls,
}: {
  label: ComponentChildren;
  hint?: ComponentChildren;
  htmlFor?: string;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <div class={`mb-5 flex flex-col gap-2 last:mb-0 ${cls ?? ''}`}>
      <label class="text-[13px] font-medium text-fg-2" for={htmlFor}>
        {label}
        {hint && <span class="ml-1.5 text-xs font-normal text-muted">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

export const inputClass =
  'w-full rounded-sm border border-line bg-field px-3.5 py-3 text-[15px] leading-normal text-white outline-none transition-[border-color,box-shadow] placeholder:text-muted focus:border-orange focus:shadow-ring';

export function Hint({ children, class: cls }: { children: ComponentChildren; class?: string }) {
  return <p class={`text-xs text-muted ${cls ?? ''}`}>{children}</p>;
}

/** Radio group styled as pills. Arrow keys move between options. */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const move = (to: number) => {
    const n = (to + options.length) % options.length;
    onChange(options[n]!.value);
    refs.current[n]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} class="flex flex-wrap gap-2">
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === index ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                move(i + 1);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(i - 1);
              }
            }}
            class={`min-h-11 cursor-pointer rounded-pill border px-3.5 text-[13px] font-medium transition-all sm:min-h-9 ${
              on
                ? 'border-orange bg-orange/12 text-white'
                : 'border-line-mid text-fg-2 hover:border-line-strong'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  labelledBy,
  describedBy,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  labelledBy: string;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={() => onChange(!checked)}
      class="relative flex h-11 w-12 flex-none cursor-pointer items-center justify-center rounded-pill"
    >
      <span
        class={`relative block h-[22px] w-[38px] rounded-pill border transition-colors ${checked ? 'border-orange bg-orange' : 'border-line bg-[#2a2a2a]'}`}
      >
        <span
          class={`absolute top-[2px] left-[2px] size-4 rounded-full transition-transform ${checked ? 'translate-x-4 bg-white' : 'bg-[#bbbbbb]'}`}
        />
      </span>
    </button>
  );
}

export function useCopy(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return [copied, copy];
}

export function CopyButton({
  text,
  label = 'Copy',
  size = 'sm',
  variant = 'outline',
}: {
  text: string;
  label?: string;
  size?: Size;
  variant?: Variant;
}) {
  const [copied, copy] = useCopy();
  return (
    <Button size={size} variant={variant} onClick={() => void copy(text)} aria-live="polite">
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {/* Both labels share one grid cell, so the button keeps the width of the longer one. */}
      <span class="grid">
        <span class={`col-start-1 row-start-1 ${copied ? 'invisible' : ''}`}>{label}</span>
        <span class={`col-start-1 row-start-1 ${copied ? '' : 'invisible'}`}>Copied</span>
      </span>
    </Button>
  );
}

/** A link (or other long value) in mono with a copy button. Wraps on small screens. */
export function LinkBox({
  value,
  highlight,
  label,
}: {
  value: string;
  highlight?: string;
  label: string;
}) {
  const [head, tail] =
    highlight && value.includes(highlight)
      ? [value.slice(0, value.indexOf(highlight)), value.slice(value.indexOf(highlight))]
      : [value, ''];
  return (
    <div class="flex flex-col gap-2 rounded-sm border border-line bg-field p-2.5 pl-3.5 sm:flex-row sm:items-center">
      <code
        aria-label={label}
        class="min-w-0 flex-1 font-mono text-[13px] leading-normal break-all text-fg-2"
      >
        {head}
        {tail && <b class="font-medium text-white">{tail}</b>}
      </code>
      <div class="flex-none self-end sm:self-auto">
        <CopyButton text={value} />
      </div>
    </div>
  );
}

export function Chip({
  children,
  tone = 'accent',
}: {
  children: ComponentChildren;
  tone?: 'accent' | 'ok' | 'off';
}) {
  const dot = tone === 'ok' ? 'bg-success' : tone === 'off' ? 'bg-muted' : 'bg-orange';
  return (
    <span class="inline-flex items-center gap-1.5 rounded-pill border border-line-soft px-[11px] py-[5px] text-xs text-fg-3">
      <span aria-hidden="true" class={`size-1.5 rounded-full ${dot}`} />
      {children}
    </span>
  );
}

export function Notice({
  children,
  tone = 'info',
  icon,
  role,
}: {
  children: ComponentChildren;
  tone?: 'info' | 'error';
  icon?: ComponentChildren;
  role?: 'alert' | 'status';
}) {
  return (
    <div
      role={role}
      class={`flex items-start gap-3 border-l-2 py-1 pl-3.5 text-sm ${tone === 'error' ? 'border-error text-error-fg' : 'border-orange text-fg-3'} [&>svg]:mt-0.5 [&>svg]:size-[18px] [&>svg]:flex-none [&>svg]:text-orange`}
    >
      {icon}
      <div class="min-w-0">{children}</div>
    </div>
  );
}

export function KeyValues({ rows }: { rows: [string, ComponentChildren, boolean?][] }) {
  return (
    <dl class="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[140px_1fr] sm:gap-y-2.5">
      {rows.map(([k, v, mono]) => (
        <Fragment key={k}>
          <dt class="mt-2 text-muted first:mt-0 sm:mt-0">{k}</dt>
          <dd class={`min-w-0 break-words text-fg-2 ${mono ? 'font-mono text-[13px]' : ''}`}>
            {v}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function HeroIcon({ children }: { children: ComponentChildren }) {
  return (
    <div
      aria-hidden="true"
      class="mb-5 flex size-12 items-center justify-center rounded-full border border-line-soft bg-orange/8 text-orange [&>svg]:size-[22px]"
    >
      {children}
    </div>
  );
}

export function PageTitle({ children }: { children: ComponentChildren }) {
  return (
    <h1 class="mb-2 font-title text-[26px] leading-tight font-medium tracking-[-0.02em] sm:text-[28px]">
      {children}
    </h1>
  );
}

export function Lede({ children }: { children: ComponentChildren }) {
  return <p class="mb-8 max-w-[640px] text-fg-3">{children}</p>;
}

export function Spinner() {
  return (
    <span
      aria-hidden="true"
      class="inline-block size-4 animate-spin rounded-full border-2 border-white/30 border-t-white motion-reduce:animate-none"
    />
  );
}
