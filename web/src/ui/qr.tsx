import { useEffect, useState } from 'preact/hooks';
import QRCode from 'qrcode';

/** QR code of a URL, rendered client-side as an SVG data URL (img-src allows data:). */
export function Qr({ value, label }: { value: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toString(value, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((svg) => {
        if (live) setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => setSrc(null));
    return () => {
      live = false;
    };
  }, [value]);
  if (!src) return null;
  return (
    <img
      src={src}
      alt={label}
      width={176}
      height={176}
      class="block size-44 rounded-sm bg-white p-2"
    />
  );
}
