import QRCode from 'qrcode';

export async function generateQrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 240,
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
  });
}
