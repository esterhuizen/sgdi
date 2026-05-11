import { ImageResponse } from 'next/og';

// Apple touch icon (180×180 PNG) — what iOS uses when the page is added
// to the home screen. Same visual mark as /icon.svg but PNG for older
// iOS support. Generated server-side via Satori + emoji-safe fallback.

export const runtime = 'nodejs';
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: '#0d1014',
          borderRadius: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          // 'G' letter
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontWeight: 700,
          fontSize: 120,
          color: '#e6edf3',
          letterSpacing: '-0.02em',
        }}
      >
        {/* Top Solana gradient stripe — flush to the top edge */}
        <div
          style={{
            display: 'flex',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 6,
            background: 'linear-gradient(90deg, #14F195 0%, #9945FF 100%)',
            borderTopLeftRadius: 32,
            borderTopRightRadius: 32,
          }}
        />
        G
      </div>
    ),
    {
      ...size,
    },
  );
}
