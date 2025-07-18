"use client"

/**
 * Privy Provider Configuration with Custom RPC URLs
 * 
 * ⚠️  IMPORTANT: To avoid rate limiting (429 errors), configure custom RPC URLs:
 * 
 * Add to your .env file:
 * NEXT_PUBLIC_ETHEREUM_RPC=https://eth-mainnet.g.alchemy.com/v2/YOUR-API-KEY
 * NEXT_PUBLIC_BASE_RPC=https://base-mainnet.g.alchemy.com/v2/YOUR-API-KEY
 * NEXT_PUBLIC_BSC_RPC=https://bsc-dataseed1.binance.org
 * NEXT_PUBLIC_POLYGON_RPC=https://polygon-mainnet.g.alchemy.com/v2/YOUR-API-KEY
 * 
 * See RPC_CONFIGURATION.md for detailed setup instructions.
 */

import { PrivyProvider as PrivyProviderBase } from '@privy-io/react-auth'
import { SmartWalletsProvider } from '@privy-io/react-auth/smart-wallets'
import { WagmiProvider, createConfig, http } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import type { Chain } from 'wagmi/chains'
import type { Transport } from 'viem'
import {
  getWagmiChains,
  DEFAULT_CHAIN,
  getAllChains,
  getMainnetChains,
  IS_TESTNET_ENABLED
} from '@/config/chains'

// Get all supported wagmi chains from config
const supportedChains = getWagmiChains()

// Create wagmi config for v2 with custom RPC URLs
const config = createConfig({
  chains: supportedChains as unknown as readonly [Chain, ...Chain[]],
  transports: supportedChains.reduce((acc, chain) => {
    acc[chain.id] = http(chain.rpcUrls.default.http[0], {
      batch: true,
    })
    return acc
  }, {} as Record<number, Transport>),
})

// Create a client for react-query
const queryClient = new QueryClient()

interface PrivyProviderProps {
  children: React.ReactNode
}

// Theme-aware Privy Provider
function ThemedPrivyProvider({ children }: PrivyProviderProps) {
  const { resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  
  // Get chains for Privy config
  const mainnetChains = IS_TESTNET_ENABLED ? getAllChains() : getMainnetChains()
  const defaultChain = DEFAULT_CHAIN.wagmiChain

  // Wait until mounted to avoid hydration mismatch
  useEffect(() => {
    setMounted(true)
  }, [])

  // Use resolvedTheme which handles 'system' automatically
  const privyTheme = mounted && resolvedTheme === 'light' ? 'light' : 'dark'

  return (
    <PrivyProviderBase
      key={privyTheme} // ✅ FORCE re-render when theme changes
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID || ''}
      config={{
        loginMethods: ['email', 'google', 'twitter', 'farcaster', 'telegram'],
        appearance: {
          theme: privyTheme, // ✅ FIXED: Sync with app theme
          accentColor: '#ff7842',
          logo: '/icons/logo.png', // ✅ FIXED: Correct logo path
          showWalletLoginFirst: false,
        },
        embeddedWallets: {
          createOnLogin: 'users-without-wallets', // Create AA wallet automatically
          priceDisplay: {
            primary: 'fiat-currency',
            secondary: 'native-token',
          },
        },
        mfa: {
          noPromptOnMfaRequired: false,
        },
        // Smart wallet configuration  
        defaultChain: defaultChain, // Set default chain from config
        supportedChains: mainnetChains.map(chain => chain.wagmiChain), // All supported chains
      }}
    >
      <SmartWalletsProvider
        config={{
          // Optional: Configure paymaster context for gasless transactions
          paymasterContext: {
            type: 'SPONSOR'
          },
        }}
      >
        <WagmiProvider config={config}>
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        </WagmiProvider>
      </SmartWalletsProvider>
    </PrivyProviderBase>
  )
}

export function PrivyProvider({ children }: PrivyProviderProps) {
  return (
    <ThemedPrivyProvider>
      {children}
    </ThemedPrivyProvider>
  )
} 