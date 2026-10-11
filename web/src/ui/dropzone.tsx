import { MAX_FILES, MAX_TOTAL_FILE_BYTES } from '@brix-share/shared';
import { useRef, useState } from 'preact/hooks';
import { FileText, Upload } from 'lucide-preact';
import { formatBytes } from '../format.ts';
import { Button, Hint } from './kit.tsx';

/** File picker and drop target with a removable list. Files never leave the browser unencrypted. */
export function Dropzone({
  files,
  onChange,
  disabled,
}: {
  files: File[];
  onChange: (f: File[]) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const total = files.reduce((n, f) => n + f.size, 0);
  const add = (list: FileList | null) => {
    if (!list) return;
    onChange([...files, ...Array.from(list)]);
  };
  return (
    <div class="flex flex-col gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          add(e.dataTransfer?.files ?? null);
        }}
        class={`flex min-h-16 w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-sm border border-dashed px-4 py-4 text-[13px] text-fg-3 transition-colors ${
          over ? 'border-orange bg-orange/8' : 'border-line bg-[#0e0e0e] hover:border-line-strong'
        }`}
      >
        <span class="flex items-center gap-2">
          <Upload aria-hidden="true" class="size-4" />
          <span>
            <b class="font-medium text-white">Drop files here</b> or click to choose
          </span>
        </span>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        class="hidden"
        aria-label="Attach files"
        onChange={(e) => {
          add(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      {files.length > 0 && (
        <ul class="flex flex-col gap-2" aria-label="Attached files">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              class="flex items-center gap-2.5 rounded-sm border border-line bg-field py-1.5 pr-1.5 pl-3 text-[13px]"
            >
              <FileText aria-hidden="true" class="size-4 flex-none text-fg-3" />
              <span class="min-w-0 flex-1 truncate text-fg-2">{f.name}</span>
              <span class="flex-none font-mono text-xs text-muted">{formatBytes(f.size)}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                aria-label={`Remove ${f.name}`}
                onClick={() => onChange(files.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Hint class={total > MAX_TOTAL_FILE_BYTES || files.length > MAX_FILES ? 'text-error-fg' : ''}>
        {files.length === 0
          ? `Optional. Up to ${MAX_FILES} files, 25 MB in total. Names and contents are encrypted.`
          : `${files.length} of ${MAX_FILES} files, ${formatBytes(total)} of 25 MB.`}
      </Hint>
    </div>
  );
}
