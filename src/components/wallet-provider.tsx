"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { baseSepolia, mainnet } from "wagmi/chains";

/** Browser-wallet connection scoped to identity and emergency-control flows. */
export const walletConfig = createConfig({
  chains: [baseSepolia, mainnet],
  multiInjectedProviderDiscovery: false,
  connectors: [
    injected({ target: "metaMask" }),
    injected({ target: "okxWallet" }),
  ],
  transports: {
    [baseSepolia.id]: http(),
    [mainnet.id]: http(),
  },
  ssr: true,
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={walletConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
