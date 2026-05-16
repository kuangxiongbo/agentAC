import type { Metadata, Viewport } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import { headers } from 'next/headers'
import { ThemeProvider } from 'next-themes'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages } from 'next-intl/server'
import { THEME_IDS } from '@/lib/themes'
import { ThemeBackground } from '@/components/ui/theme-background'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
})

function resolveMetadataBase(): URL {
  const candidates = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.MC_PUBLIC_BASE_URL,
    process.env.APP_URL,
    process.env.MISSION_CONTROL_PUBLIC_URL,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)

  for (const candidate of candidates) {
    try {
      return new URL(candidate)
    } catch {
      // Ignore invalid URL values and continue fallback chain.
    }
  }

  // Prevent localhost fallback in production metadata when env is unset.
  return new URL('https://mission-control.local')
}

const metadataBase = resolveMetadataBase()

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
}

export const metadata: Metadata = {
  title: 'E-Agent-Center — AI Agent Orchestration Dashboard',
  description: 'Open-source dashboard for AI agent orchestration. Manage agent fleets, dispatch tasks, track costs, and coordinate multi-agent workflows. Self-hosted, zero dependencies, SQLite-powered.',
  metadataBase,
  icons: {
    icon: [
      { url: '/brand/app-logo.png', type: 'image/png', sizes: 'any' },
    ],
    apple: [{ url: '/brand/app-logo.png', sizes: 'any', type: 'image/png' }],
    shortcut: ['/brand/app-logo.png'],
  },
  openGraph: {
    title: 'E-Agent-Center — AI Agent Orchestration Dashboard',
    description: 'Open-source dashboard for AI agent orchestration. Manage agent fleets, dispatch tasks, track costs, and coordinate multi-agent workflows.',
    images: [{ url: '/brand/app-logo.png', width: 512, height: 512, alt: 'E-Agent-Center — AI agent orchestration dashboard' }],
    type: 'website',
    siteName: 'E-Agent-Center',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'E-Agent-Center — AI Agent Orchestration Dashboard',
    description: 'Open-source dashboard for AI agent orchestration. Manage agent fleets, dispatch tasks, track costs, and coordinate multi-agent workflows.',
    images: ['/brand/app-logo.png'],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'E-Agent-Center',
  },
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const nonce = process.env.NODE_ENV === 'production'
    ? ((await headers()).get('x-nonce') || undefined)
    : undefined
  const locale = await getLocale()
  const messages = await getMessages()

  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'} className="dark" suppressHydrationWarning>
      <head>
        {/* Blocking script to set 'dark' class before first paint, preventing FOUC.
            Content is a static string literal — no user input, no XSS vector. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme')||'void';var light=['light','paper'];if(light.indexOf(t)===-1)document.documentElement.classList.add('dark')}catch(e){}})()`,
          }}
        />
      </head>
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`} suppressHydrationWarning>
        <NextIntlClientProvider messages={messages}>
          <ThemeProvider
            attribute="class"
            defaultTheme="void"
            themes={THEME_IDS}
            enableSystem={false}
            disableTransitionOnChange
          >
            <ThemeBackground />
            <div className="h-screen overflow-hidden bg-background text-foreground">
              {children}
            </div>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
