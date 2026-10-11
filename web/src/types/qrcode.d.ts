// Hand-written types for the one qrcode function the app uses (no @types/qrcode, see DECISIONS.md).
declare module 'qrcode' {
  interface ToStringOptions {
    type: 'svg';
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    margin?: number;
    color?: { dark?: string; light?: string };
  }
  const QRCode: {
    toString(text: string, options: ToStringOptions): Promise<string>;
  };
  export default QRCode;
}
