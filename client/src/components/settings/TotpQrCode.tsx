import { QRCodeSVG } from 'qrcode.react';

/** Render locally: enrollment secrets must never be sent to an external QR service. */
export const TotpQrCode = ({ uri, title }: { uri: string; title: string }) => <QRCodeSVG
    value={uri}
    size={208}
    marginSize={4}
    level="M"
    bgColor="#ffffff"
    fgColor="#000000"
    title={title}
    style={{ display: 'block', gridColumn: '1 / -1', justifySelf: 'center', maxWidth: '100%', height: 'auto' }}
/>;
