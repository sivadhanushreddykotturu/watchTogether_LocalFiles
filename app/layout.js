import { Bebas_Neue, Instrument_Sans, JetBrains_Mono } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';

const display = Bebas_Neue({ weight: '400', subsets: ['latin'], variable: '--font-display' });
const body = Instrument_Sans({ weight: ['400', '500', '600'], subsets: ['latin'], variable: '--font-body' });
const mono = JetBrains_Mono({ weight: ['400', '600'], subsets: ['latin'], variable: '--font-mono' });

export const metadata = {
  title: 'ReelSync — watch local files together',
  description: 'Everyone opens their own copy of the file. ReelSync keeps every screen in lockstep.',
};

export default function RootLayout({ children }) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
